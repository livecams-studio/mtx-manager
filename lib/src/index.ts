import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { logger } from 'hono/logger';
import util from 'util';

import { stringify } from 'yaml';
import { GlobalConfig } from './schema/mediamtx/global.js';
import { PathConfig } from './schema/mediamtx/path.js';

type MediaMTXConfig = {
  pathDefaults: PathConfig;
  paths: Record<string, PathConfig>;
} & GlobalConfig;

interface Commands {
  global: {
    runOnConnect: Record<string, string>;
    runOnDisconnect: Record<string, string>;
  };
  path: {
    runOnDemand: Record<string, string>;
    runOnUnDemand: Record<string, string>;
    runOnReady: Record<string, string>;
    runOnNotReady: Record<string, string>;
    runOnRead: Record<string, string>;
    runOnUnread: Record<string, string>;
  };
}

const defaultHookConfiguration = {
  global: {
    runOnConnect: {
      scope: 'global',
      event: 'connect',
      id: '$MTX_CONN_ID',
      type: '$MTX_CONN_TYPE'
    },
    runOnDisconnect: {
      scope: 'global',
      event: 'disconnect',
      id: '$MTX_CONN_ID',
      type: '$MTX_CONN_TYPE'
    }
  },
  path: {
    runOnDemand: {
      scope: 'path',
      event: 'demand',
      path: '$MTX_PATH'
    },
    runOnUnDemand: {
      scope: 'path',
      event: 'un_demand',
      path: '$MTX_PATH'
    },
    runOnReady: {
      scope: 'path',
      event: 'ready',
      path: '$MTX_PATH',
      id: '$MTX_SOURCE_ID',
      type: '$MTX_SOURCE_TYPE'
    },
    runOnNotReady: {
      scope: 'path',
      event: 'not_ready',
      path: '$MTX_PATH',
      id: '$MTX_SOURCE_ID',
      type: '$MTX_SOURCE_TYPE'
    },
    runOnRead: {
      scope: 'path',
      event: 'read',
      path: '$MTX_PATH',
      id: '$MTX_READER_ID',
      query: '$MTX_QUERY',
      type: '$MTX_READER_TYPE'
    },
    runOnUnread: {
      scope: 'path',
      event: 'unread',
      path: '$MTX_PATH',
      id: '$MTX_READER_ID',
      query: '$MTX_QUERY',
      type: '$MTX_READER_TYPE'
    }
  }
} satisfies Commands;

type CommandGeneratorParams = { base: string } & Commands;

interface LifecycleCommand {
  global: Partial<GlobalConfig>;
  path: Partial<PathConfig>;
}
type CommandGenerator = (params: CommandGeneratorParams) => LifecycleCommand;

const busybox: CommandGenerator = params => {
  const toPostData = (data: Record<string, string>) => {
    const params = new URLSearchParams(data);
    return params.toString();
  };

  return {
    global: {
      runOnConnect: `busybox wget --post-data='${toPostData(params.global.runOnConnect)}' -qO- ${params.base}`,
      runOnDisconnect: `busybox wget --post-data='${toPostData(params.global.runOnDisconnect)}' -qO- ${params.base}`
    },
    path: {
      runOnDemand: `busybox wget --post-data='${toPostData(params.path.runOnDemand)}' -qO- ${params.base}`,
      runOnUnDemand: `busybox wget --post-data='${toPostData(params.path.runOnUnDemand)}' -qO- ${params.base}`,
      runOnReady: `busybox wget --post-data='${toPostData(params.path.runOnReady)}' -qO- ${params.base}`,
      runOnNotReady: `busybox wget --post-data='${toPostData(params.path.runOnNotReady)}' -qO- ${params.base}`,
      runOnRead: `busybox wget --post-data='${toPostData(params.path.runOnRead)}' -qO- ${params.base}`,
      runOnUnread: `busybox wget --post-data='${toPostData(params.path.runOnUnread)}' -qO- ${params.base}`
    }
  };
};

const auth = {
  http: (config: { base: string }) => {
    return {
      authMethod: 'http',
      authHTTPAddress: `${config.base}`
    } satisfies Partial<GlobalConfig>;
  },
  process: (action: 'publish' | 'read', params: { path: string; ip: string; user: string; query: string; password: string; protocol: string; id: string; token: string }) => {
    console.log(`Auth: ${action}`);
    console.log(util.inspect(params, { depth: null, colors: true }));
    return true;
  }
};

const server = 'https://eu.broadcast.shared.livecams.studio';
const control = 'http://localhost:3000';
const app = new Hono();
app.use(logger());

const hooks = busybox({ base: `${control}/config/hooks`, ...defaultHookConfiguration });

const config = {
  rtmp: true,
  webrtc: true,
  hls: false,
  rtsp: false,
  srt: false,

  ...auth.http({ base: `${control}/config/auth` }),
  ...hooks.global,

  pathDefaults: {
    ...hooks.path
  },
  paths: {
    obs: {
      record: true,
      recordPath: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
      recordFormat: 'fmp4',
      recordSegmentDuration: '1h',
      recordPartDuration: '5s',
      recordMaxPartSize: '50M',
      recordDeleteAfter: '14d'
    }
  }
} satisfies MediaMTXConfig;

const handler = (config: MediaMTXConfig) => {
  const app = new Hono();
  app.use(async (c, next) => {
    const start = Date.now();
    await next();
    const end = Date.now();
    console.log(`${c.req.method} ${c.req.url} ${end - start}ms`);
  });

  app.get('/', c => {
    console.log(`Serving config`);
    return c.text(stringify(config), 200, { 'Content-Type': 'application/yaml' });
  });

  app.post('/hooks', async c => {
    const data = await c.req.formData();
    const json = Object.fromEntries(data.entries());
    const scope = json.scope as 'global' | 'path';
    const event = json.event as 'connect' | 'disconnect' | 'demand' | 'un_demand' | 'ready' | 'not_ready' | 'read' | 'unread' | 'record_segment_create' | 'record_segment_complete';
    console.log(`Event: ${scope}/${event}`);
    console.log(util.inspect(json, { depth: null, colors: true }));

    return c.text('OK', 200);
  });

  app.post('/auth', async c => {
    const data = await c.req.json();
    const result = auth.process(data.action, data);
    if (result) {
      return c.json({ result }, 200);
    } else {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  });

  return app;
};

app.route('/config', handler(config));

serve(app, async info => {
  console.log(`Server is running on ${info.address}:${info.port}`);
});
