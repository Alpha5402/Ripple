export type SourceOffset = number

export interface SourceRange {
  from: SourceOffset
  to: SourceOffset
}

export interface SourceSelection {
  anchor: SourceOffset
  head: SourceOffset
}

export type EditOrigin =
  | 'keyboard'
  | 'command'
  | 'paste'
  | 'composition'
  | 'api'
  | 'undo'
  | 'redo'

export interface SourceChange {
  range: SourceRange
  insert: string
}

export interface EditTransaction {
  changes: SourceChange[]
  origin: EditOrigin
  historyGroup?: string
  selectionBefore?: SourceSelection
  selectionAfter?: SourceSelection
}

export interface AppliedEditTransaction {
  transaction: EditTransaction
  inverse: EditTransaction
  before: string
  after: string
}

function assertValidChanges(source: string, changes: SourceChange[]): SourceChange[] {
  const sorted = [...changes].sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to)
  let previousEnd = -1

  for (const change of sorted) {
    const { from, to } = change.range
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > source.length) {
      throw new RangeError(`Invalid source range [${from}, ${to}) for source length ${source.length}`)
    }
    if (from < previousEnd) {
      throw new RangeError('Source changes must not overlap')
    }
    previousEnd = to
  }

  return sorted
}

/**
 * Canonical Markdown source storage.
 *
 * Parsed block/inline models are projections only. Every mutation must pass
 * through apply(), which also provides an exact inverse transaction.
 */
export class SourceDocument {
  private value: string
  private revision = 0

  constructor(initialSource: string) {
    this.value = initialSource
  }

  get source(): string {
    return this.value
  }

  get version(): number {
    return this.revision
  }

  slice(range: SourceRange): string {
    return this.value.slice(range.from, range.to)
  }

  replace(source: string): void {
    this.value = source
    this.revision += 1
  }

  apply(transaction: EditTransaction): AppliedEditTransaction {
    const before = this.value
    const changes = assertValidChanges(before, transaction.changes)
    const inverseChanges: SourceChange[] = []
    let delta = 0

    for (const change of changes) {
      const removed = before.slice(change.range.from, change.range.to)
      const inverseFrom = change.range.from + delta
      inverseChanges.push({
        range: {
          from: inverseFrom,
          to: inverseFrom + change.insert.length
        },
        insert: removed
      })
      delta += change.insert.length - (change.range.to - change.range.from)
    }

    let after = before
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]
      after = after.slice(0, change.range.from) + change.insert + after.slice(change.range.to)
    }

    this.value = after
    this.revision += 1

    return {
      transaction: { ...transaction, changes },
      inverse: {
        changes: inverseChanges,
        origin: transaction.origin === 'undo' ? 'redo' : 'undo',
        historyGroup: transaction.historyGroup,
        selectionBefore: transaction.selectionAfter,
        selectionAfter: transaction.selectionBefore
      },
      before,
      after
    }
  }
}
