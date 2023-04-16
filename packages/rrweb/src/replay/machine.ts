/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-plus-operands */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { createMachine, interpret, assign, StateMachine } from '@xstate/fsm';
import type { playerConfig } from '../types';
import {
  eventWithTime,
  ReplayerEvents,
  EventType,
  Emitter,
  IncrementalSource,
  mouseInteractionData,
} from '@rrweb/types';
import { Timer, addDelay } from './timer';

export type PlayerContext = {
  events: eventWithTime[];
  totalInteractionEvents?: eventWithTime[];
  willStopByStep?: boolean;
  timer: Timer;
  timeOffset: number;
  baselineTime: number;
  lastPlayedEvent: eventWithTime | null;
};
export type PlayerEvent =
  | {
      type: 'PLAY';
      payload: {
        timeOffset: number;
      };
    }
  | {
      type: 'CAST_EVENT';
      payload: {
        event: eventWithTime;
      };
    }
  | { type: 'PAUSE' }
  | { type: 'TO_LIVE'; payload: { baselineTime?: number } }
  | {
      type: 'ADD_EVENT';
      payload: {
        event: eventWithTime;
      };
    }
  | {
      type: 'END';
    };
export type PlayerState =
  | {
      value: 'playing';
      context: PlayerContext;
    }
  | {
      value: 'paused';
      context: PlayerContext;
    }
  | {
      value: 'live';
      context: PlayerContext;
    };

/**
 * If the array have multiple meta and fullsnapshot events,
 * return the events from last meta to the end.
 */
export function discardPriorSnapshots(
  events: eventWithTime[],
  baselineTime: number,
): eventWithTime[] {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx];
    if (event.type === EventType.Meta) {
      if (event.timestamp <= baselineTime) {
        return events.slice(idx);
      }
    }
  }
  return events;
}

type PlayerAssets = {
  emitter: Emitter;
  applyEventsSynchronously(events: Array<eventWithTime>): void;
  getCastFn(event: eventWithTime, isSync: boolean): () => void;
};
export function createPlayerService(
  context: PlayerContext,
  { getCastFn, applyEventsSynchronously, emitter }: PlayerAssets,
) {
  const playerMachine = createMachine<PlayerContext, PlayerEvent, PlayerState>(
    {
      id: 'player',
      context,
      initial: 'paused',
      states: {
        playing: {
          on: {
            PAUSE: {
              target: 'paused',
              actions: ['pause'],
            },
            CAST_EVENT: {
              target: 'playing',
              actions: 'castEvent',
            },
            END: {
              target: 'paused',
              actions: ['resetLastPlayedEvent', 'pause'],
            },
            ADD_EVENT: {
              target: 'playing',
              actions: ['addEvent'],
            },
          },
        },
        paused: {
          on: {
            PLAY: {
              target: 'playing',
              actions: ['recordTimeOffset', 'play'],
            },
            CAST_EVENT: {
              target: 'paused',
              actions: 'castEvent',
            },
            TO_LIVE: {
              target: 'live',
              actions: ['startLive'],
            },
            ADD_EVENT: {
              target: 'paused',
              actions: ['addEvent'],
            },
          },
        },
        live: {
          on: {
            ADD_EVENT: {
              target: 'live',
              actions: ['addEvent'],
            },
            CAST_EVENT: {
              target: 'live',
              actions: ['castEvent'],
            },
          },
        },
      },
    },
    {
      actions: {
        castEvent: assign({
          lastPlayedEvent: (ctx, event) => {
            if (event.type === 'CAST_EVENT') {
              return event.payload.event;
            }
            return ctx.lastPlayedEvent;
          },
        }),
        recordTimeOffset: assign((ctx, event) => {
          let timeOffset = ctx.timeOffset;
          if ('payload' in event && 'timeOffset' in event.payload) {
            timeOffset = event.payload.timeOffset;
          }
          return {
            ...ctx,
            timeOffset,
            baselineTime: ctx.events[0].timestamp + timeOffset,
          };
        }),
        play(ctx) {
          const { timer, events, baselineTime, lastPlayedEvent, willStopByStep, } = ctx;
          timer.clear();

          for (const event of events) {
            // TODO: improve this API
            addDelay(event, baselineTime);
          }
          const neededEvents = discardPriorSnapshots(events, baselineTime);

          let lastPlayedTimestamp = lastPlayedEvent?.timestamp;
          if (
            lastPlayedEvent?.type === EventType.IncrementalSnapshot &&
            lastPlayedEvent.data.source === IncrementalSource.MouseMove
          ) {
            lastPlayedTimestamp =
              lastPlayedEvent.timestamp +
              lastPlayedEvent.data.positions[0]?.timeOffset;
          }
          if (baselineTime < (lastPlayedTimestamp || 0)) {
            emitter.emit(ReplayerEvents.PlayBack);
          }
          const bundleStore: Map<number, eventWithTime[]> = new Map();
          const syncEvents = new Array<eventWithTime>();
          for (const event of neededEvents) {
            if (
              lastPlayedTimestamp &&
              lastPlayedTimestamp < baselineTime &&
              (event.timestamp <= lastPlayedTimestamp ||
                event === lastPlayedEvent)
            ) {
              //对于步进播放，可能出现mousedown 和click 同时进行，之前的判断会导致timestamp 一样的情况时，click 被过滤了
              if (
                willStopByStep &&
                event.timestamp == lastPlayedTimestamp &&
                // eslint-disable-next-line no-empty
                (event.data as mouseInteractionData).source == 2 &&
                (event.data as mouseInteractionData).type == 2
              // eslint-disable-next-line no-empty
              ) {
              } else {
                continue;
              }
            }
            if (event.timestamp < baselineTime) {
              syncEvents.push(event);
            } else {
              // if (
              //   // eslint-disable-next-line no-empty
              //   (event.data as mouseInteractionData).source == 2 &&
              //   (event.data as mouseInteractionData).type == 2
              // // eslint-disable-next-line no-empty
              // ) {
              //   console.error('play-添加元素', event)
              // }
              if (event.isBundle) {
                // Bundle Event 共享同样的时间戳，因此提取出来做性能优化
                if (bundleStore.has(event.timestamp)) {
                  bundleStore.get(event.timestamp)?.push(event);
                } else {
                  bundleStore.set(event.timestamp, [event]);
                }
              } else {
                const castFn = getCastFn(event, false);
                timer.addAction({
                  doAction: () => {
                    castFn();
                  },
                  delay: event.delay!,
                  event: event,
                });
              }
            }
          }
          for (const bundleArr of bundleStore.values()) {
            // 将所有的 bundle Event 使用 applyEventsSynchronously 处理
            const neededInBundle = discardPriorSnapshots(bundleArr, bundleArr[0].timestamp + 1);
            if (!neededInBundle.length) {
              continue;
            }
            timer.addAction({
              doAction: () => {
                console.log('### replay bundle events', neededInBundle.length);
                applyEventsSynchronously(neededInBundle);
                emitter.emit(ReplayerEvents.Flush);
              },
              delay: neededInBundle[0].delay!,
            });
          }
          applyEventsSynchronously(syncEvents);
          emitter.emit(ReplayerEvents.Flush);
          timer.start();
        },
        pause(ctx) {
          ctx.timer.clear();
        },
        resetLastPlayedEvent: assign((ctx) => {
          return {
            ...ctx,
            lastPlayedEvent: null,
          };
        }),
        startLive: assign({
          baselineTime: (ctx, event) => {
            ctx.timer.start();
            if (event.type === 'TO_LIVE' && event.payload.baselineTime) {
              return event.payload.baselineTime;
            }
            return Date.now();
          },
        }),
        addEvent: assign((ctx, machineEvent) => {
          const { baselineTime, timer, events } = ctx;
          if (machineEvent.type === 'ADD_EVENT') {
            const { event } = machineEvent.payload;
            addDelay(event, baselineTime);

            let end = events.length - 1;
            if (!events[end] || events[end].timestamp <= event.timestamp) {
              // fast track
              events.push(event);
            } else {
              let insertionIndex = -1;
              let start = 0;
              while (start <= end) {
                const mid = Math.floor((start + end) / 2);
                if (events[mid].timestamp <= event.timestamp) {
                  start = mid + 1;
                } else {
                  end = mid - 1;
                }
              }
              if (insertionIndex === -1) {
                insertionIndex = start;
              }
              events.splice(insertionIndex, 0, event);
            }

            const isSync = event.timestamp < baselineTime;
            const castFn = getCastFn(event, isSync);
            if (isSync) {
              castFn();
            } else if (timer.isActive()) {
              timer.addAction({
                doAction: () => {
                  castFn();
                },
                delay: event.delay!,
              });
            }
          }
          return { ...ctx, events };
        }),
      },
    },
  );
  return interpret(playerMachine);
}

export type SpeedContext = {
  normalSpeed: playerConfig['speed'];
  timer: Timer;
};

export type SpeedEvent =
  | {
      type: 'FAST_FORWARD';
      payload: { speed: playerConfig['speed'] };
    }
  | {
      type: 'BACK_TO_NORMAL';
    }
  | {
      type: 'SET_SPEED';
      payload: { speed: playerConfig['speed'] };
    };

export type SpeedState =
  | {
      value: 'normal';
      context: SpeedContext;
    }
  | {
      value: 'skipping';
      context: SpeedContext;
    };

export function createSpeedService(context: SpeedContext) {
  const speedMachine = createMachine<SpeedContext, SpeedEvent, SpeedState>(
    {
      id: 'speed',
      context,
      initial: 'normal',
      states: {
        normal: {
          on: {
            FAST_FORWARD: {
              target: 'skipping',
              actions: ['recordSpeed', 'setSpeed'],
            },
            SET_SPEED: {
              target: 'normal',
              actions: ['setSpeed'],
            },
          },
        },
        skipping: {
          on: {
            BACK_TO_NORMAL: {
              target: 'normal',
              actions: ['restoreSpeed'],
            },
            SET_SPEED: {
              target: 'normal',
              actions: ['setSpeed'],
            },
          },
        },
      },
    },
    {
      actions: {
        setSpeed: (ctx, event) => {
          if ('payload' in event) {
            ctx.timer.setSpeed(event.payload.speed);
          }
        },
        recordSpeed: assign({
          normalSpeed: (ctx) => ctx.timer.speed,
        }),
        restoreSpeed: (ctx) => {
          ctx.timer.setSpeed(ctx.normalSpeed);
        },
      },
    },
  );

  return interpret(speedMachine);
}

export type PlayerMachineState = StateMachine.State<
  PlayerContext,
  PlayerEvent,
  PlayerState
>;

export type SpeedMachineState = StateMachine.State<
  SpeedContext,
  SpeedEvent,
  SpeedState
>;
