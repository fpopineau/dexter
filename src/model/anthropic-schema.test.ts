import { describe, expect, test } from 'bun:test';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SchemaSafeChatAnthropic } from './llm.js';

// Offline: formatStructuredToolToAnthropic is pure — the dummy key never
// leaves the process.
const model = new SchemaSafeChatAnthropic({ model: 'claude-sonnet-5', apiKey: 'test-key' });

const unionTool = new DynamicStructuredTool({
    name: 'union_tool',
    description: 'root schema is a discriminated union (the proposals/orders/account/earnings shape)',
    schema: z.discriminatedUnion('action', [
        z.object({ action: z.literal('list'), limit: z.coerce.number().default(10) }),
        z.object({ action: z.literal('get'), id: z.string() }),
    ]),
    func: async () => 'ok',
});

const objectTool = new DynamicStructuredTool({
    name: 'object_tool',
    description: 'plain object root',
    schema: z.object({ q: z.string() }),
    func: async () => 'ok',
});

describe('SchemaSafeChatAnthropic (Sonnet 5 tools.N.input_schema.type 400 regression)', () => {
    test('union-rooted tool schemas are flattened to a single object', () => {
        const formatted = model.formatStructuredToolToAnthropic([unionTool, objectTool])!;
        const union = formatted.find((t) => t.name === 'union_tool') as { input_schema: Record<string, unknown> };
        const s = union.input_schema;
        expect(s.type).toBe('object');
        // Anthropic rejects any top-level union keyword — none may survive
        expect(s.oneOf).toBeUndefined();
        expect(s.anyOf).toBeUndefined();
        const props = s.properties as Record<string, Record<string, unknown>>;
        // discriminator consts merged into one enum
        expect(props.action.enum).toEqual(['list', 'get']);
        // branch-specific fields present but not globally required
        expect(props.id.type).toBe('string');
        expect(s.required).toEqual(['action']);
    });

    test('ordinary object tools pass through unchanged', () => {
        const formatted = model.formatStructuredToolToAnthropic([objectTool])!;
        const obj = formatted[0] as { input_schema: Record<string, unknown> };
        expect(obj.input_schema.type).toBe('object');
        expect(obj.input_schema.anyOf).toBeUndefined();
    });
});
