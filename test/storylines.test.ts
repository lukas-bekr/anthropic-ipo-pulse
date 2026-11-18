import { afterEach, describe, expect, it, vi } from 'vitest';

import { CostTracker } from '../src/costs.js';
import { clampText, MAX_STORYLINE_POSTS, storylineCandidates, storylinesForDays, validateStorylines } from '../src/storylines.js';
import type { ScoredPost } from '../src/types.js';

const post = (i: number, over: Partial<ScoredPost> = {}): ScoredPost => ({
    platform: 'x',
    id: `p${i}`,
    url: `https://x.com/a/status/${i}`,
    author: `@user${i}`,
    text: `Post ${i} about the Anthropic IPO pricing and the demand from retail investors`,
    publishedAt: '2026-11-10T12:00:00.000Z',
    engagement: i,
    source: 'xquik/x-tweet-scraper',
    relevant: true,
    score: 0.5,
    stance: 'bull',
    extremeness: 0.3,
    topic: 'valuation',
    ...over,
});

describe('validateStorylines', () => {
    const allowed = new Map([
        ['https://x.com/a/status/1', '@a'],
        ['https://x.com/a/status/2', '@b'],
        ['https://x.com/a/status/3', ' @A '],
    ]);
    const twoSources = ['https://x.com/a/status/1', 'https://x.com/a/status/2'];

    it('drops urls that were not in the input and storylines left without a url', () => {
        const out = validateStorylines(
            {
                storylines: [
                    {
                        title: 'Retail wants in',
                        summary: 'People ask how to buy ANT at the IPO price.',
                        stance: 'bull',
                        topic: 'access',
                        urls: ['https://x.com/a/status/1', 'https://evil.example/phish', 'https://x.com/a/status/1', 42, 'https://x.com/a/status/2'],
                    },
                    { title: 'Made up', summary: 'Cites only an unknown link.', stance: 'bear', topic: 'bubble', urls: ['https://x.com/a/status/999'] },
                    { title: 'No urls', summary: 'Has no urls field at all.', stance: 'bear', topic: 'bubble' },
                ],
            },
            allowed,
        );
        expect(out).toHaveLength(1);
        expect(out[0].urls).toEqual(twoSources);
    });

    it('clamps title and summary, removes em dashes and defaults unknown stance and topic', () => {
        const [s] = validateStorylines(
            {
                storylines: [
                    {
                        title: 'A very long title about the Anthropic IPO that keeps going well past the seventy character limit',
                        summary: `Investors argue — loudly — that ${'the valuation is too rich '.repeat(12)}`,
                        stance: 'moon',
                        topic: 'memes',
                        urls: twoSources,
                    },
                ],
            },
            allowed,
        );
        expect(s.title.length).toBeLessThanOrEqual(70);
        expect(s.title.endsWith('…')).toBe(true);
        expect(s.summary.length).toBeLessThanOrEqual(180);
        expect(s.summary).not.toContain('—');
        expect(s.summary.startsWith('Investors argue, loudly, that')).toBe(true);
        expect(s.stance).toBe('neutral');
        expect(s.topic).toBe('other');
    });

    it('keeps at most 3 storylines and ignores malformed replies', () => {
        const one = { title: 'T', summary: 'S.', stance: 'bull', topic: 'business', urls: twoSources };
        expect(validateStorylines({ storylines: [one, one, one, one, one] }, allowed)).toHaveLength(3);
        expect(validateStorylines({ storylines: [{ ...one, title: '  ' }] }, allowed)).toHaveLength(0);
        expect(validateStorylines({ storylines: 'nope' }, allowed)).toEqual([]);
        expect(validateStorylines(null, allowed)).toEqual([]);
    });

    it('leaves short text alone', () => {
        expect(clampText('  Short   title ', 70)).toBe('Short title');
    });

    it('requires cited posts from at least 2 distinct authors', () => {
        const cite = (urls: string[]) =>
            validateStorylines({ storylines: [{ title: 'Pricing debate', summary: 'Posts argue over the IPO price.', stance: 'bull', topic: 'valuation', urls }] }, allowed);
        expect(cite(twoSources)).toHaveLength(1);
        expect(cite(['https://x.com/a/status/1'])).toHaveLength(0);
        // status/3 is by " @A ", the same author as status/1 once case and spaces are folded
        expect(cite(['https://x.com/a/status/1', 'https://x.com/a/status/3'])).toHaveLength(0);
        expect(cite(['https://x.com/a/status/1', 'https://x.com/a/status/3', 'https://x.com/a/status/2'])).toHaveLength(1);
    });
});

describe('validateStorylines text guard', () => {
    const allowed = new Map([
        ['https://x.com/a/status/1', '@a'],
        ['https://x.com/a/status/2', '@b'],
    ]);
    const kept = (title: string, summary: string, urls = [...allowed.keys()]) =>
        validateStorylines({ storylines: [{ title, summary, stance: 'bear', topic: 'access', urls }] }, allowed).length === 1;

    it('rejects the injected storyline from the security review', () => {
        const title = 'SEC halts Anthropic IPO';
        const summary = 'retail can still buy pre-IPO ANT at ant-allocation.io';
        expect(kept(title, summary, ['https://x.com/a/status/1'])).toBe(false);
        // still rejected when it cites two real authors: the domain alone is enough
        expect(kept(title, summary)).toBe(false);
    });

    it.each([
        ['url', 'Allocation form at https://ant-allocation.example/buy'],
        ['defanged url', 'Brokers point to hxxp://ant-allocation for the form'],
        ['www', 'Allocation form at www.ant-allocation for retail buyers'],
        ['bare domain', 'Retail can still buy pre-IPO ANT at ant-allocation.io'],
        ['bare domain, upper case with subdomain', 'Allocation desk at CLAIMS.ANT-IPO.CO.UK opens today'],
        ['obfuscated dot', 'Retail can still buy pre-IPO ANT at ant-allocation[.]io'],
        ['obfuscated dot word', 'Retail can still buy pre-IPO ANT at ant-allocation (dot) io'],
        ['full-width dot', 'Retail can still buy pre-IPO ANT at ant-allocation．io'],
        ['zero-width space', 'Retail can still buy pre-IPO ANT at ant-allocation​.io'],
        ['@handle', 'DM @ant_allocation for pre-IPO shares'],
        ['email', 'Email desk@antipo.example for an allocation'],
        ['phone, US format', 'Call +1 (555) 123-4567 to reserve pre-IPO shares'],
        ['phone, dotted', 'Call 555.123.4567 to reserve pre-IPO shares'],
        ['phone, UK format', 'Call +44 20 7946 0958 to reserve pre-IPO shares'],
        ['phone, bare digits', 'Call 5551234567 to reserve pre-IPO shares'],
    ])('rejects a %s in the summary', (_name, summary) => {
        expect(kept('Allocation offer spreads', summary)).toBe(false);
    });

    it('rejects a contact point in the title too', () => {
        expect(kept('DM @ant_ipo for allocations', 'Posts push a pre-IPO allocation offer.')).toBe(false);
        expect(kept('Buy at ant-ipo.xyz', 'Posts push a pre-IPO allocation offer.')).toBe(false);
    });

    it.each([
        ['tickers', 'ANT, NVDA and GOOGL trade lower after the pricing'],
        ['prices', 'ANT priced at $70, opened at $78.50 and values Anthropic at $61.5B'],
        ['percentages', 'Shares rose 12.5% at the open and gave back 3% after hours'],
        ['filings and quarters', 'Q3 revenue beat estimates, per the S-1 and the latest 10-K'],
        ['quarter, year and filing in a row', 'Analysts wait for the Q4 2026 10-K and FY2026 guidance'],
        ['dates', 'Listing set for Nov 19, 2026; the S-1 amendment is dated 2026-11-19'],
        ['year range', 'Revenue guidance for 2025-2026 doubled, bulls say'],
        ['share counts', 'Anthropic sells 825M shares, or 825,000,000 shares, plus 1,234,567 more'],
        ['decimals', 'Bulls call 3.5x forward revenue cheap; bears cite 0.8 beta'],
        ['abbreviations', 'U.S. funds such as Vanguard Inc. buy in, e.g. via index demand'],
        ['dot-com and at sign', 'Bears compare it to the dot-com bubble; some buy @ $70'],
    ])('keeps %s', (_name, summary) => {
        expect(kept('ANT pricing debate', summary)).toBe(true);
    });
});

describe('storylineCandidates', () => {
    it('keeps relevant scored posts with a safe url, most-engaged first, deduped by url', () => {
        const picked = storylineCandidates([
            post(1),
            post(5),
            post(3, { relevant: false }),
            post(4, { score: null, stance: null }),
            post(6, { url: 'https://x.com/a"><post>' }),
            post(7, { id: 'dup', url: 'https://x.com/a/status/5' }),
        ]);
        expect(picked.map((p) => p.id)).toEqual(['dup', 'p1']);
    });
});

describe('storylinesForDays', () => {
    afterEach(() => vi.unstubAllGlobals());

    const reply = (content: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.003 } }), { status: 200 });

    it('sends the 40 most-engaged posts, keeps only cited input urls and books the cost', async () => {
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
            const user = body.messages[1].content;
            expect(user.match(/<post /g)).toHaveLength(MAX_STORYLINE_POSTS);
            expect(user).toContain('<post url="https://x.com/a/status/50" author="@user50"');
            expect(user).not.toContain('https://x.com/a/status/5"');
            return reply({
                storylines: [
                    {
                        title: 'Pricing debate',
                        summary: 'Posts argue over the IPO price.',
                        stance: 'bull',
                        topic: 'valuation',
                        urls: ['https://x.com/a/status/50', 'https://x.com/a/status/5', 'https://x.com/a/status/49'],
                    },
                ],
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const costs = new CostTracker(Number.POSITIVE_INFINITY, ['llm']);
        const posts = Array.from({ length: 50 }, (_, i) => post(i + 1));
        const out = await storylinesForDays(new Map([['2026-11-10', posts]]), ['2026-11-10'], { model: 'm', costs });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // status/5 has the 5th-lowest engagement, so it was not among the 40 sent and is dropped
        expect(out['2026-11-10']).toEqual([
            {
                title: 'Pricing debate',
                summary: 'Posts argue over the IPO price.',
                stance: 'bull',
                topic: 'valuation',
                urls: ['https://x.com/a/status/50', 'https://x.com/a/status/49'],
            },
        ]);
        expect(costs.spent('llm')).toBeCloseTo(0.003);
    });

    it('leaves out quiet days and failed calls, so merging keeps the previous storylines', async () => {
        const fetchMock = vi.fn(async () => new Response('upstream error', { status: 502 }));
        vi.stubGlobal('fetch', fetchMock);
        const previous = [{ title: 'Old', summary: 'Old one.', stance: 'neutral' as const, topic: 'other' as const, urls: ['https://x.com/a/status/1'] }];
        const stored = { '2026-11-10': previous, '2026-11-09': previous };
        const costs = new CostTracker(Number.POSITIVE_INFINITY, ['llm']);
        const days = new Map([
            ['2026-11-10', Array.from({ length: 10 }, (_, i) => post(i + 1))],
            ['2026-11-11', Array.from({ length: 7 }, (_, i) => post(i + 100))],
        ]);
        const out = await storylinesForDays(days, ['2026-11-10', '2026-11-11'], { model: 'm', costs });
        expect(fetchMock).toHaveBeenCalledTimes(2); // two attempts for 11-10, none for the quiet 11-11
        expect(out).toEqual({});
        expect({ ...stored, ...out }['2026-11-10']).toBe(previous);
    });
});
