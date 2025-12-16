import { createStore } from '@xstate/store';

interface BaseRequiredUserProperties {
  id: string;
}

type Action = string;
interface AuthenticationActionParams {
  username: string;
  password: string;
  token: string;
  ip: string;
  action: Action;
  query?: string;
}

type AuthenticationCallback<User> = (params: AuthenticationActionParams) => Promise<User | false>;
interface Connection {
  node: string;
  id: string;
  authenticatedUserId?: string;
}

interface Path {
  node: string;
  name: string;
  publisher: string;
  readers: Array<string>;
}

interface Node {
  name: string;
  active: boolean;
}

const createNodesStore = <User extends BaseRequiredUserProperties = BaseRequiredUserProperties>() => {
  return createStore({
    context: {
      nodes: [] as Array<Node>,
      users: [] as Array<User & { node: string }>,
      connections: [] as Array<Connection>,
      paths: [] as Array<Path>
    },

    on: {
      upsert_user: (context, event: User & { node: string }) => {},
      upsert_connection: (context, event: Connection) => {},

      path_ready: (context, event: { node: string; path: string; by: string }) => {},
      path_unready: (context, event: { node: string; path: string; by: string }) => {},
      path_demanded: (context, event: { node: string; path: string; by: string }) => {},
      path_undemanded: (context, event: { node: string; path: string; by: string }) => {},
      path_read: (context, event: { node: string; path: string; by: string }) => {},
      path_unread: (context, event: { node: string; path: string; by: string }) => {}
    }
  });
};

interface User {
  id: string;
}

const store = createNodesStore<User>();
const auth: AuthenticationCallback<User> = async ({ ip }) => {
  if (ip !== '127.0.0.1') return false;
  return { id: '1' };
};

const node = 'default-1';
store.send({
  node,
  type: 'upsert_connection',
  id: '1'
});

store.send({
  node,
  type: 'upsert_user',
  id: '1'
});

store.send({
  node,
  type: 'upsert_connection',

  id: '1',
  authenticatedUserId: '1'
});

store.subscribe(({ context }) => {
  console.log(context);
});
