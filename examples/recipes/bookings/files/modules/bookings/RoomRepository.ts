import { Repository } from '@marmeon/database';

export class RoomRepository extends Repository<'rooms'> {
  static table = 'rooms' as const;
}
