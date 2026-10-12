import { describe, expect, it } from 'vitest';
import { composeFalkorAnswer } from '../src/graph/falkordb-store.js';

describe('composeFalkorAnswer', () => {
  it('builds claims and citations only from FalkorDB facts with source episodes', () => {
    const answer = composeFalkorAnswer('Why is payment retry capped at 30 seconds?', [
      {
        factId: 'fact-cap', relation: 'DECIDED', factText: 'The retry cap is 30 seconds to protect the payment SLO.',
        sourceName: 'Payments Platform', targetName: 'Payments API', confidence: 0.96,
        episodeId: 'episode-adr-42', sourceType: 'decision', sourceLabel: 'ADR-042',
        episodeContent: 'ADR-042: Bound exponential retry backoff at 30 seconds to protect the payment SLO.',
        validAt: '2026-09-14T09:00:00.000Z', invalidAt: null, visibility: '{}',
      },
      {
        factId: 'fact-unsupported', relation: 'MENTIONS', factText: 'An uncited detail.',
        sourceName: 'Payments API', targetName: 'Provider', confidence: 0.8,
        episodeId: null, sourceType: null, sourceLabel: null, episodeContent: null,
        validAt: '2026-09-14T09:00:00.000Z', invalidAt: null, visibility: '{}',
      },
    ]);

    expect(answer.answer).toContain('30 seconds');
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0]?.evidenceIds).toEqual(['episode-adr-42']);
    expect(answer.citations).toHaveLength(1);
    expect(answer.path).toEqual([{ from: 'Payments Platform', edge: 'DECIDED', to: 'Payments API' }]);
  });

  it('returns an explicit no-evidence answer for unmatched graph rows', () => {
    const answer = composeFalkorAnswer('Who owns an unknown system?', []);
    expect(answer.citations).toEqual([]);
    expect(answer.claims).toEqual([]);
    expect(answer.missing).not.toHaveLength(0);
    expect(answer.answer).toMatch(/no source-backed facts/i);
  });

  it('filters restricted fact and source visibility unless the caller matches', () => {
    const row = {
      factId: 'fact-private', relation: 'DECIDED', factText: 'A restricted decision.',
      sourceName: 'Team', targetName: 'Service', confidence: 0.9,
      episodeId: 'episode-private', sourceType: 'decision', sourceLabel: 'Private ADR',
      episodeContent: 'Restricted source content.', validAt: '2026-09-14T09:00:00.000Z', invalidAt: null,
      visibility: JSON.stringify({ allowedPrincipals: ['asha'] }),
      episodeVisibility: JSON.stringify({ allowedPrincipals: ['asha'] }),
    };
    expect(composeFalkorAnswer('decision', [row]).citations).toEqual([]);
    expect(composeFalkorAnswer('decision', [row], { principalId: 'asha' }).citations).toHaveLength(1);
  });
});

  it('ranks direct textual evidence when a question does not mention an entity name', async () => {
    const { rankFalkorAnswerRows } = await import('../src/graph/falkordb-store.js');
    const rows = [
      { factId: 'old', factText: 'The original retry policy allowed backoff up to 60 seconds.', sourceLabel: 'ADR-017', episodeContent: 'Original policy: backoff up to 60 seconds.', validAt: '2026-03-03T09:00:00.000Z' },
      { factId: 'new', factText: 'The retry cap is 30 seconds to protect the payment SLO.', sourceLabel: 'ADR-042', episodeContent: 'Cap exponential backoff at 30 seconds.', validAt: '2026-09-14T09:00:00.000Z' },
      { factId: 'owner', factText: 'Payments Platform owns the Payments API.', sourceLabel: 'CODEOWNERS', episodeContent: 'Payments Platform owns payment service.' },
    ];

    expect(rankFalkorAnswerRows('What changed from 60 to 30 seconds?', rows).map(row => row.factId)).toEqual(['new', 'old']);
  });
import { FalkorDBStore } from '../src/graph/falkordb-store.js';

describe('real-data graph store', () => {
  it('does not expose a production demo seeding operation', () => {
    expect('seedDemo' in new FalkorDBStore('localhost')).toBe(false);
  });
});
