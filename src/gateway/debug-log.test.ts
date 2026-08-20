import { describe, expect, test } from 'bun:test';
import { redact } from './debug-log.js';

describe('debug-log redact (WP0.6 — identity never hits disk raw)', () => {
    test('phone-length digit runs mask to last 4', () => {
        expect(redact('from=33612345678@s.whatsapp.net')).toBe('from=…5678@s.whatsapp.net');
        expect(redact('selfJid=4915112345678:12@lid')).toBe('selfJid=…5678:12@lid');
    });

    test('short numbers (order ids, counts) stay readable', () => {
        expect(redact('order 12345 filled qty=100')).toBe('order 12345 filled qty=100');
    });

    test('multiple identities in one line all mask', () => {
        const line = redact('from=33612345678 to=49157654321 group=120363041234567890@g.us');
        expect(line).not.toContain('33612345678');
        expect(line).not.toContain('49157654321');
        expect(line).not.toContain('120363041234567890');
    });
});
