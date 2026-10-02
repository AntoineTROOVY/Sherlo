import { TABLE_IMPORTERS } from './table-importers';

/**
 * The sessions importer is the one restore path that writes a value later used to build an on-disk
 * auth-directory path, and it bypasses CreateSessionDto. Both columns matter: the id keys the
 * directory, the name is matched against the legacy one. A row carrying a traversal in either must
 * be skipped with a reason rather than inserted.
 */
describe('sessions table importer', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: '0a941dac-a965-45e7-b318-74ae8be134f0',
    name: 'my-bot',
    status: 'created',
    ...overrides,
  });

  it('accepts a row whose id and name are both safe path keys', () => {
    expect(sessions?.skip?.(row({}) as never)).toBeNull();
  });

  it('skips a row whose id would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ id: '../../etc' }) as never)).toMatch(/unsafe id/);
  });

  it('skips a row whose name would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ name: '../alice' }) as never)).toMatch(/unsafe name/);
  });
});

describe('sessions table importer: desiredState', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const base = { id: '0a941dac-a965-45e7-b318-74ae8be134f0', name: 'my-bot', status: 'disconnected' };
  const mapped = (extra: Record<string, unknown>): unknown[] => sessions!.map({ ...base, ...extra } as never);

  it('writes desiredState so a stopped session stays down after a restore', () => {
    expect(sessions?.sql).toContain('"desiredState"');
    expect(sessions?.sql).toContain('$13');
    expect(mapped({ desiredState: 'stopped' })[12]).toBe('stopped');
  });

  it('restores a row without the field, or with an unknown value, as eligible (NULL)', () => {
    expect(mapped({})[12]).toBeNull();
    expect(mapped({ desiredState: 'bogus' })[12]).toBeNull();
  });
});

/**
 * A restore bypasses CreateWebhookDto. Dispatch reads a filters object without a conditions array as
 * "no filtering", so a malformed one stored verbatim would deliver every subscribed event; a non-list
 * events column silently never fires. Both are vetoed with a reason instead.
 */
describe('webhooks table importer', () => {
  const webhooks = TABLE_IMPORTERS.find(importer => importer.key === 'webhooks');
  const skip = (overrides: Record<string, unknown>) =>
    webhooks?.skip?.({ id: 'wh-1', events: ['message.received'], filters: null, ...overrides } as never);
  const chatFilter = { conditions: [{ field: 'isGroup', operator: 'is', value: true }] };

  it('accepts events and filters in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ events: '["message.received","*"]', filters: JSON.stringify(chatFilter) })).toBeNull();
    expect(skip({ filters: chatFilter })).toBeNull();
    expect(skip({ events: undefined, filters: undefined })).toBeNull();
  });

  it.each([['message.received'], ['not json'], [{ 0: 'message.received' }], [[1]], ['[null]']])(
    'skips a row whose events is %j',
    events => {
      expect(skip({ events })).toMatch(/events/);
    },
  );

  it.each([[{}], [{ conditions: 'x' }], ['not json'], ['{}'], [{ conditions: [{ field: 'nope', operator: 'is' }] }]])(
    'skips a row whose filters is %j',
    filters => {
      expect(skip({ filters })).toMatch(/filters/);
    },
  );
});

/**
 * A restore bypasses the automation rule DTOs. A conditions value without a conditions array matches
 * every inbound message, so a malformed one stored verbatim would autoreply to every contact.
 */
describe('automationRules table importer', () => {
  const automationRules = TABLE_IMPORTERS.find(importer => importer.key === 'automationRules');
  const skip = (overrides: Record<string, unknown>) =>
    automationRules?.skip?.({ id: 'rule-1', conditions: null, ...overrides } as never);
  const chatCondition = { conditions: [{ field: 'isGroup', operator: 'is', value: false }] };

  it('accepts no conditions, or conditions in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ conditions: undefined })).toBeNull();
    expect(skip({ conditions: chatCondition })).toBeNull();
    expect(skip({ conditions: JSON.stringify(chatCondition) })).toBeNull();
  });

  it.each([
    [{ condition: [] }],
    [{ conditions: 'x' }],
    [{ conditions: [null] }],
    ['not json'],
    [{ conditions: [{ field: 'nope', operator: 'is' }] }],
  ])('skips a row whose conditions is %j', conditions => {
    expect(skip({ conditions })).toMatch(/Skipped automation rule rule-1: invalid conditions/);
  });
});

/**
 * A restore writes with raw SQL, so the NUL drop the entities apply to their free-text columns never
 * runs. PostgreSQL rejects U+0000 in a bound parameter, and an older SQLite backup may hold one, also
 * in template and rule text written before the DTOs refused it, so the importers drop it from those
 * columns and leave ids and lookup keys as they are. A template name is dropped too: no request can
 * look up a name holding NUL, so keeping it only made the template unreachable by name.
 */
describe('table importers: NUL in free text', () => {
  const nul = 'a\u0000b';
  const mapped = (key: string, row: Record<string, unknown>): unknown[] =>
    TABLE_IMPORTERS.find(importer => importer.key === key)!.map(row as never);

  it.each([
    ['sessions', { id: 's1', name: 'my-bot', pushName: nul }, [4]],
    ['messages', { id: 'm1', chatId: nul, chatName: nul, body: nul, mediaMimetype: nul }, [4, 8, 16]],
    [
      'statusUpdates',
      { id: 'su1', contactJid: nul, contactName: nul, contactPushName: nul, caption: nul, mediaMimetype: nul },
      [3, 4, 7, 9],
    ],
    ['webhookDeliveryFailures', { id: 'wf1', lastError: nul }, [9]],
    ['integrationDeliveryFailures', { id: 'df1', lastError: nul }, [7]],
    ['templates', { id: 't1', name: nul, body: nul, header: nul, footer: nul }, [2, 3, 4, 5]],
    ['automationRules', { id: 'r1', name: nul, replyText: nul }, [2, 5]],
  ])('drops it from the %s text columns', (key, row, columns) => {
    const params = mapped(key, row);
    columns.forEach(index => expect(params[index]).toBe('ab'));
  });

  it('keeps it in a lookup column', () => {
    expect(mapped('messages', { id: 'm1', chatId: nul })[3]).toBe(nul);
    expect(mapped('statusUpdates', { id: 'su1', contactJid: nul })[2]).toBe(nul);
  });
});
