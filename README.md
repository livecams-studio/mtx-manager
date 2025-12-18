# mtx-manager


mtx-manager is a config, state and authentication manager for [MediaMTX](https://mediamtx.org). It does not need to be ran on the same machine or need inbound network access to MediaMTX. It supports multiple instances of MediaMTX and works with the vanilla [`bluenviron/mediamtx:latest-ffmpeg`](https://hub.docker.com/r/bluenviron/mediamtx) docker image.

This makes it perfect for ephemeral or high availability MediaMTX deployments where instances can be managed in one place & mirrored to fallback to. For our usecase, we built this to enable distributed, flexible compute options for conversation organisations deploying 24/7 livecams. 

> This README represents the target API & usage of mtx-manager. This is at very early stages and most of the functionality is not yet implemented.

## Usage

While you can use & deploy this library anywhere, we have default adaptors for the hono library & a starter template for Cloudflare Workers. This is an example of the most "batteries included" setup:

```ts
import { Hono } from 'hono';
import { manager } from '@livecams/mtx-manager/hono';
import { regex } from 'arkregex';

const app = new Hono();

app.route('/', manager({
  base: 'https://example.com',
  key: 'SHARED_KEY',
  
  config: {
    paths: {
      fixed: path({}), // Uses key ('fixed') by default
      static: path('static_path', {}),
      dynamic: path(regex('dynamic_(.*)'), {}) // Type-safe dynamic regex paths
    }
  },
  auth: async ({ action, actor, payload }) => {
    // Add your own authentication logic
    log(action, actor, payload);
    
    const limit = await getRateLimit(actor.ip);
    if (limit.status === 'exceeded') return false;
    
    const auth = await authenticate(actor);
    if (auth.status === 'unauthorized') return false;
    
    const permission = await hasPermission(auth.user, action, payload);
    if (permission.status === 'denied') return false;
    
    return true;
  },
  on: (store) => {
    store.subscribe(snapshot => {
      // Called whenever any state changes
      console.log(snapshot.context);
    });
    
    
    // More complicated custom selector
    const nodes = store.select(
      (context) => context.nodes,
      (prev, next) => {
        // Calculate when status changes
        return hasStatusChanged(prev, next);
      }
    );
    nodes.subscribe((nodes) => {
      // Called whenever the status of the nodes change
      console.log(nodes);
    });
  }
}));

export default app;
```

See examples below for options with less magic where you can compose your own configuration & state management.


## Using with MediaMTX

Once your manager is deployed somewhere on the internet, running a MediaMTX node can be as easy as this:

```sh
docker run -d \
  --name mediamtx \
  -p 1935:1935 \
  -p 8889:8889 \
  -P 8189:8189/udp \
  --entrypoint sh \
  bluenviron/mediamtx:latest-ffmpeg \
  -c 'busybox wget --header "Authorization: Bearer SHARED_KEY" "https://example.com?node=example" -O /etc/mediamtx.yml && exec /mediamtx'
```

The generated `mediamtx.yml` file uses the [lifecycle hooks](https://mediamtx.org/docs/usage/hooks), dynamic paths & external http authentication features of MediaMTX to do a huge amount of the configuration without needing a custom MediaMTX build, docker image or sidecar that calls the Control API.

That simple example has one major downside, the config can’t be changed until the service is restarted. This will drop all existing connections and take a little time to restart. That’s true even when using something like `docker-compose`.

MediaMTX already has support for best-attempt hot reloading of the config file, only dropping connections for paths that have been changed. We offer a tiny, lightweight sidecar that keeps the file updated & gives us an extra heartbeat metric.

```yml
services:
  mediamtx:
    image: bluenviron/mediamtx:latest-ffmpeg
    ports:
      - '1935:1935/tcp' # RTSP
      - '8889:8889/tcp' # WebRTC HTTP
      - '8189:8189/udp' # ICE/RTP
    volumes:
      - config_data:/config
    command: ['/config/mediamtx.yml']
    depends_on:
      updater:
        condition: service_healthy

  updater:
    image: livecams/mtx-updater:latest
    environment:
      URL: https://example.com/
      KEY: SHARED_KEY
      NODE: example
    volumes:
      - config_data:/config

volumes:
  config_data:
```

## Recording

If you want to use the playback API to retrieve existing recordings, you can use another small sidecar that integrates with the manager. This uses a job system where the sidecar pulls down jobs, uploads clips to object storage and then reports back to the manager. This continues to avoid the need to expose MediaMTX to the internet.

See the [Recording & Playback proposal](docs/proposals/recording-playback.md) for the composable architecture and implementation plan.

```ts
import { manager } from '@livecams/mtx-manager/hono';
import { s3 } from '@livecams/mtx-manager/storage';

const mediamtx = manager({
  base: 'https://example.com',
  key: 'SHARED_KEY',
  
  config: {
    paths: {
      cam: path({
        source: 'rtsp://user:password@100.100.100.100/cam',
        
        record: true,
        recordPath: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
        recordFormat: 'fmp4',
        recordSegmentDuration: '1h',
        recordPartDuration: '5s',
        recordMaxPartSize: '50M',
        recordDeleteAfter: '14d'
      }),
    }
  },
  
  storage: s3(
    endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    credentials: {
      accessKeyId: 'ACCESS_KEY',
      secretAccessKey: 'SECRET_KEY'
    },
    bucket: 'BUCKET_NAME'
  )
}


const result = await mediamtx.playback.get('cam', {
  start: new Date(),
  duration: 10_000
})

console.log(result)
/*
  {
    id: '019b28eb-1ae2-766c-8d00-e12570bb3070',
    duration: 10000,
    start: '2023-01-01T00:00:00.000Z',
    end: '2023-01-01T00:00:10.000Z',
    size: 100024,
    bucket: 'BUCKET_NAME',
    filename: '019b28eb-1ae2-766c-8d00-e12570bb3070.mp4',
    mime: 'video/mp4',
    url: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com/recordings/019b28eb-1ae2-766c-8d00-e12570bb3070.mp4'
  }
*/

```

```yml
services:
  mediamtx:
    image: bluenviron/mediamtx:latest-ffmpeg
    ports:
      - '1935:1935/tcp' # RTSP
      - '8889:8889/tcp' # WebRTC HTTP
      - '8189:8189/udp' # ICE/RTP
      - '9996:9996/tcp' # Playback API
    volumes:
      - config_data:/config
      - /mnt/recordings:/recordings
    command: ['/config/mediamtx.yml']
    depends_on:
      updater:
        condition: service_healthy

  updater:
    image: livecams/mtx-updater:latest
    environment:
      URL: https://example.com/
      KEY: SHARED_KEY
      NODE: example
    volumes:
      - config_data:/config
      
  playback:
    image: livecams/mtx-playback:latest
    environment:
      URL: https://example.com/
      KEY: SHARED_KEY
      NODE: example
      MEDIAMTX_URL: http://mediamtx:9996

volumes:
  config_data:
```


## Low-level API

The manager has a ton of state management and magic to provide a straightforward API for high-level control. We also export all of the lower level pieces that the manager composes together so you can use them directly, if you want a less batteries included approach.


### Basic example, just configuration

This is the most basic example, just serving the configuration file.

```ts
import { Hono } from 'hono';
import { MediaMTXConfig } from '@livecams/mtx-manager';
import { handler } from '@livecams/mtx-manager/hono';

const config = {
  webrtc: true,
  paths: {
    path1: {}
  }
} satisfies MediaMTXConfig;

const app = new Hono();
app.route('/', handler(config));
export default app;
```

### Basic example, configuration & events

By configuring the [lifecycle hooks](https://mediamtx.org/docs/usage/hooks) with commands to call the manager, we can listen & response to events. This comes in two parts, a command generator and a router. We provide a built-in ‘busybox wget’ generator, as this is included in the default docker container. If you’re working with a different environment, you can make your own generator. We also provide a built-in hono adapter for the router component.

```ts
import { Hono } from 'hono';
import { MediaMTXConfig } from '@livecams/mtx-manager';
import { handler } from '@livecams/mtx-manager/hono';
import { busybox, defaultHookConfiguration } from '@livecams/mtx-manager/hooks';

const hooks = busybox({ base: 'https://example.com/hooks', ...defaultHookConfiguration });

const config = {
  webrtc: true,
  ...hooks.global,
  
  pathDefaults: {
    ...hooks.path
  },
  
  paths: {
    path1: {}
  }
} satisfies MediaMTXConfig;

const app = new Hono();
app.route('/', handler(config, {
  on: (scope, event, payload) => {
    console.log('scope', scope);
    console.log('event', event);
    console.log('payload', payload);
  }
}));
export default app;
```

Basic example, configuration, auth & events

```ts
import { Hono } from 'hono';
import { MediaMTXConfig } from '@livecams/mtx-manager';
import { handler } from '@livecams/mtx-manager/hono';
import { busybox, defaultHookConfiguration } from '@livecams/mtx-manager/hooks';
import { http } from '@livecams/mtx-manager/auth';

const hooks = busybox({ base: 'https://example.com/hooks', ...defaultHookConfiguration });
const auth = http({ base: 'https://example.com/auth' }))

const config = {
  webrtc: true,
  ...hooks.global,
  ...auth.global,

  pathDefaults: {
    ...hooks.path
  },
  
  paths: {
    path1: {}
  }
} satisfies MediaMTXConfig;

const app = new Hono();
app.route('/', handler(config, {
  on: (scope, event, payload) => {
    console.log('scope', scope);
    console.log('event', event);
    console.log('payload', payload);
  },
  auth: async (params) => {
    // Add your own authentication logic
    if (await isUserAuthorized(params)) {
      return true;
    }
    return false;
  }
}));
export default app;
```
