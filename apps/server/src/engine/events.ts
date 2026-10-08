import { EventEmitter } from 'node:events';
import type { Redactor } from '../lib/redact.ts';
import type { EventRow, Store } from '../store/db.ts';

/** Новое событие журнала. */
export interface NewEvent {
  runId?: string | null;
  stepId?: string | null;
  type: string;
  message?: string | null;
  data?: unknown;
}

/**
 * Шина событий: сохраняет событие в журнал с маскированием секретов и рассылает подписчикам SSE.
 * Событие 'event' получает сохраненную строку журнала.
 */
export class EventBus extends EventEmitter {
  private readonly store: Store;
  private readonly redact: Redactor;

  constructor(store: Store, redact: Redactor) {
    super();
    this.store = store;
    this.redact = redact;
    this.setMaxListeners(200);
  }

  emitEvent(e: NewEvent): EventRow {
    const row = this.store.addEvent({
      ...e,
      message: e.message == null ? null : this.redact.text(e.message),
      data: this.redact.deep(e.data),
    });
    this.emit('event', row);
    return row;
  }
}
