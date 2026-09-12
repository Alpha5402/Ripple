import type { EditTransaction } from './SourceDocument'

/**
 * 光标位置信息，用于 Undo/Redo 后恢复光标。
 */
export interface CursorInfo {
  blockId: string
  offset: number
  isRawOffset: boolean
  /** Canonical UTF-16 source offset; authoritative across projection changes. */
  sourceOffset?: number
  /** Optional focus/head offset for restoring a non-collapsed selection. */
  headSourceOffset?: number
}

export interface HistoryState {
  source: string
  blockIds: string[]
}

export interface HistoryRestore {
  transaction: EditTransaction
  blockIds: string[]
  cursor: CursorInfo | null
}

interface HistoryEntry {
  forward: EditTransaction
  inverse: EditTransaction
  beforeBlockIds: string[]
  afterBlockIds: string[]
  cursorBefore: CursorInfo | null
  cursorAfter: CursorInfo | null
  timestamp: number
}

interface PendingCapture {
  state: HistoryState
  cursor: CursorInfo | null
}

/**
 * Transaction-based editor history.
 *
 * `beginTransaction` is called immediately before an editor action. The next
 * action (or Undo) seals the previous capture by calculating the smallest
 * contiguous source change. Full source strings are only held transiently by
 * `pending`; undo/redo stacks retain the forward and inverse transactions.
 */
export class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private pending: PendingCapture | null = null

  constructor(private readonly maxStackSize: number = 100) {}

  beginTransaction(state: HistoryState, cursor?: CursorInfo | null): void {
    this.sealPending(state, cursor ?? null)
    this.pending = {
      state: cloneState(state),
      cursor: cursor ?? null
    }
    this.redoStack = []
  }

  undo(currentState: HistoryState, currentCursor?: CursorInfo | null): HistoryRestore | null {
    this.sealPending(currentState, currentCursor ?? null)
    const entry = this.undoStack.pop()
    if (!entry) return null

    this.redoStack.push(entry)
    return {
      transaction: entry.inverse,
      blockIds: [...entry.beforeBlockIds],
      cursor: entry.cursorBefore
    }
  }

  redo(currentState: HistoryState, currentCursor?: CursorInfo | null): HistoryRestore | null {
    this.sealPending(currentState, currentCursor ?? null)
    const entry = this.redoStack.pop()
    if (!entry) return null

    this.undoStack.push(entry)
    return {
      transaction: entry.forward,
      blockIds: [...entry.afterBlockIds],
      cursor: entry.cursorAfter
    }
  }

  get canUndo(): boolean {
    return this.pending !== null || this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  private sealPending(afterState: HistoryState, cursorAfter: CursorInfo | null): void {
    const pending = this.pending
    this.pending = null
    if (!pending || pending.state.source === afterState.source) return

    const { forward, inverse } = sourceTransactions(
      pending.state.source,
      afterState.source
    )
    this.undoStack.push({
      forward,
      inverse,
      beforeBlockIds: [...pending.state.blockIds],
      afterBlockIds: [...afterState.blockIds],
      cursorBefore: pending.cursor,
      cursorAfter,
      timestamp: Date.now()
    })
    if (this.undoStack.length > this.maxStackSize) this.undoStack.shift()
  }
}

function cloneState(state: HistoryState): HistoryState {
  return {
    source: state.source,
    blockIds: [...state.blockIds]
  }
}

function sourceTransactions(before: string, after: string): {
  forward: EditTransaction
  inverse: EditTransaction
} {
  let prefix = 0
  const sharedLength = Math.min(before.length, after.length)
  while (prefix < sharedLength && before[prefix] === after[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1
  }

  const beforeTo = before.length - suffix
  const afterTo = after.length - suffix
  return {
    forward: {
      origin: 'redo',
      changes: [{
        range: { from: prefix, to: beforeTo },
        insert: after.slice(prefix, afterTo)
      }]
    },
    inverse: {
      origin: 'undo',
      changes: [{
        range: { from: prefix, to: afterTo },
        insert: before.slice(prefix, beforeTo)
      }]
    }
  }
}
