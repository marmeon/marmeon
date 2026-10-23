import { describe, expect, it } from 'vitest';
import { ownDatabases } from './test-databases.ts';

describe('the teardown of the test databases', () => {
  const mine = ['marmeon_test_aaaa1111_0123456789ab', 'marmeon_cache_aaaa1111_0123456789ab', 'marmeon_test_aaaa1111_k3j2h_1', 'marmeon_schedule_aaaa1111_ffffffffffff'];
  const theirs = ['marmeon_test_bbbb2222_0123456789ab', 'marmeon_queue_bbbb2222_0123456789ab', 'marmeon_test_bbbb2222_k3j2h_1'];

  it('drops the databases of its own checkout and leaves another checkout’s run alone', () => {
    expect(ownDatabases([...mine, ...theirs, 'marmeon', 'postgres', 'shop_test_aaaa1111_1'], 'marmeon', 'aaaa1111')).toEqual(mine);
    expect(ownDatabases([...mine, ...theirs], 'marmeon', 'bbbb2222')).toEqual(theirs);
  });

  it('leaves databases without a tag alone, and a tag that only starts alike', () => {
    expect(ownDatabases(['marmeon_test_0123456789ab', 'marmeon_test_aaaa11112_x'], 'marmeon', 'aaaa1111')).toEqual([]);
  });
});
