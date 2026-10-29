import { everyone } from './access.ts';
import { defineRequest, type ContextOf } from './request-definition.ts';
import { defineRoutes } from './router.ts';
import type { RouteBinder } from './types.ts';

interface Room {
  id: number;
  name: string;
}
declare class Rooms implements RouteBinder<Room> {
  resolveRouteBinding(value: string): Room | undefined;
}
declare class Teams implements RouteBinder<{ id: number }> {
  resolveRouteBinding(value: string): { id: number } | undefined;
}

const ShowRoomRequest = defineRequest({});

class ShowRoom {
  static request = ShowRoomRequest;
  handle(ctx: ContextOf<typeof ShowRoomRequest, { room: Room }>) {
    const name: string = ctx.params.room.name;
    // @ts-expect-error — `nam` is no property of the bound row.
    const typo = ctx.params.room.nam;
    return [name, typo];
  }
}

class ShowTeam {
  static request = ShowRoomRequest;
  handle(ctx: ContextOf<typeof ShowRoomRequest, { team: { id: number } }>) {
    return ctx.params.team.id;
  }
}

class ShowStringRoom {
  static request = ShowRoomRequest;
  handle(ctx: ContextOf<typeof ShowRoomRequest, { room: string }>) {
    return ctx.params.room;
  }
}

export default defineRoutes((Route) => {
  const open = Route.authorize(everyone);

  open.bind('room', Rooms, { public: true }).get('/rooms/:room', ShowRoom);
  // @ts-expect-error — the registrar binds no `room`: the controller would read a string as a row.
  open.get('/rooms/:room', ShowRoom);
  // @ts-expect-error — the registrar binds `room`, not `team`.
  open.bind('room', Rooms, { public: true }).get('/rooms/:room', ShowTeam);
  // @ts-expect-error — `room` is bound to a row, the controller names a string.
  open.bind('room', Rooms, { public: true }).get('/rooms/:room', ShowStringRoom);
  open.bind('team', Teams, { public: true }).get('/teams/:team', ShowTeam);
});
