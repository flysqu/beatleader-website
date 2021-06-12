import eventBus from '../utils/broadcast-channel-pubsub'
import log from '../utils/logger'
import createQueue, {PRIORITY} from '../utils/queue'
import createConfigStore from '../stores/config'
import createRankedsStore from '../stores/scoresaber/rankeds'
import createPlayerService from '../services/scoresaber/player'
import {HOUR, MINUTE} from '../utils/date'
import {opt} from '../utils/js'

const INTERVAL_TICK = MINUTE;

let initialized = false;
let mainPlayerId = null;
let rankedsStore = null;
let playerService = null;

const TYPES = {
  RANKEDS: {name: 'RANKEDS', priority: PRIORITY.LOW},
  RANKEDS_NOTES_CACHE: {name: 'RANKEDS-NOTES-CACHE', priority: PRIORITY.LOWEST},
  PLAYER_SCORES: {name: 'PLAYER-SCORE', priority: PRIORITY.NORMAL},
  ACTIVE_PLAYERS: {name: 'ACTIVE-PLAYERS', priority: PRIORITY.HIGH},
  MAIN_PLAYER: {name: 'MAIN-PLAYER', priority: PRIORITY.HIGHEST},
}

const enqueue = async (queue, type, force = false, data = null, then = null) => {
  if (!type || !type.name || !Number.isFinite(type.priority)) {
    log.warn(`Unknown type enqueued.`, 'DlManager', type);

    return;
  }

  log.debug(`Try to enqueue type ${type.name}. Forced: ${force}, data: ${JSON.stringify(data)}`, 'DlManager');

  const priority = force ? PRIORITY.HIGHEST : type.priority;

  switch (type) {
    case TYPES.MAIN_PLAYER:
      if (mainPlayerId) {
        log.debug(`Enqueue main player`, 'DlManager');

        await Promise.all([
          enqueue(queue, {...TYPES.ACTIVE_PLAYERS, priority: PRIORITY.HIGHEST}, force, {playerId: mainPlayerId}),
          enqueue(queue, {...TYPES.PLAYER_SCORES, priority: PRIORITY.HIGHEST}, force, {playerId: mainPlayerId}),
        ]);
      }
      break;

    case TYPES.RANKEDS:
      log.debug(`Enqueue rankeds`, 'DlManager');

      if (!rankedsStore) rankedsStore = await createRankedsStore();

      queue.add(async () => rankedsStore.refresh(force), priority);
      break;

    case TYPES.ACTIVE_PLAYERS:
      log.debug(`Enqueue active players`, 'DlManager');

      if (data && data.playerId)
        queue.add(async () => playerService.refresh(data.playerId, force), priority);
      else
        queue.add(async () => playerService.refreshAll(force), priority);
      break;

    case TYPES.RANKEDS_NOTES_CACHE:
      // await enqueueRankedsNotesCache(queue, then);
      break;

    case TYPES.PLAYER_SCORES:
      // if (data && data.playerId)
        // await enqueueActivePlayersScores(queue, force, then);
      // else
        // await enqueuePlayerScores(queue, data.playerId, force, then);
  }

  if (then) {
    log.debug('Processing then command...', 'DlManager');

    await then();
  }
}

const enqueueAllJobs = async queue => {
  log.debug(`Try to enqueue & process queue.`, 'DlManager');

  await Promise.all([
    enqueue(queue, TYPES.MAIN_PLAYER),
    enqueue(queue, TYPES.RANKEDS),
    enqueue(queue, TYPES.ACTIVE_PLAYERS),
    enqueue(queue, TYPES.PLAYER_SCORES),
    enqueue(queue, TYPES.RANKEDS_NOTES_CACHE)
  ])
}

let intervalId;
const startSyncing = async queue => {
  await enqueueAllJobs(queue);
  intervalId = setInterval(() => enqueueAllJobs(queue), INTERVAL_TICK);
}

export default async () => {
  if (initialized) {
    log.debug(`Download manager already initialized.`, 'DlManager');

    return;
  }

  const queue = createQueue({
    concurrency: 1,
    timeout: HOUR * 2,
    throwOnTimeout: true,
  });

  const configStore = await createConfigStore();
  mainPlayerId = configStore.getMainPlayerId();

  configStore.subscribe(config => {
    const newMainPlayerId = opt(config, 'users.main')
    if (mainPlayerId !== newMainPlayerId) {
      mainPlayerId = newMainPlayerId;

      log.debug(`Main player changed to ${mainPlayerId}`, 'DlManager')
    }
  })

  playerService = createPlayerService();

  eventBus.leaderStore.subscribe(async isLeader => {
    if (isLeader) {
      queue.clear();
      queue.start();

      log.info(`Node is a leader, queue processing enabled`, 'DlManager')

      await startSyncing(queue)
    }
  })

  // TODO: consider whether to add a new player via the download manager or directly via the service
  eventBus.on('player-add-cmd', async ({playerId}) => {
    await enqueue(
      queue, TYPES.ACTIVE_PLAYERS, true,
      {playerId},
      async () => enqueue(queue, TYPES.PLAYER_SCORES, true, {playerId}),
    );
  });

  eventBus.on('dl-manager-pause-cmd', () => {
    log.debug('Pause Dl Manager', 'DlManager');

    queue.clear();
    queue.pause();
  });

  eventBus.on('dl-manager-unpause-cmd', () => {
    log.debug('Unpause Dl Manager', 'DlManager');

    queue.clear();
    queue.start();
  });

  if (eventBus.isLeader()) await startSyncing(queue);

  initialized = true;

  log.info(`Download manager initialized`, 'DlManager');
}