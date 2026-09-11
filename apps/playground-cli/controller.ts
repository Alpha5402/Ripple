import { KnowledgeService, KernelError } from '../../packages/core/index.js';
import { ExplorationSession } from '../../packages/sdk/session.js';

export class Playground {
  readonly session: ExplorationSession;
  constructor(readonly service: KnowledgeService) { this.session = new ExplorationSession(service); }
  async indexEmbeddings(argument: string): Promise<string> {
    const selected = argument && argument !== 'all' ? [this.resolve(argument)] : undefined;
    const report = await this.service.indexEmbeddings(selected ? { documentIds: selected } : {});
    return JSON.stringify({ encoded: report.encoded, reused: report.reused, discarded: report.discarded, cancelled: report.cancelled, coverage: this.service.getEmbeddingCoverage() }, null, 2);
  }
  private resolve(input: string): string {
    const value = input.replace(/^(["'])(.*)\1$/, '$2');
    if (this.service.getNode(value)) return value;
    const resolution = this.service.resolveEntity(value, this.session.current?.snapshot.focusNode);
    if (resolution.status !== 'resolved') throw new KernelError('NOT_FOUND', `${resolution.status}: ${value}${resolution.candidates.length ? ' → ' + resolution.candidates.map(t => this.service.getNode(t.documentId)!.path).join(', ') : ''}`);
    return resolution.candidates[0]!.documentId;
  }
  private title(id: string): string { return this.service.getNode(id)?.parsed.title ?? id; }
  private printRelations(all = false): string {
    const current = this.session.current;
    if (!current) throw new KernelError('NOT_FOUND', 'Use focus <name> first');
    const view = this.session.visible();
    const relations = all ? this.service.getRelations(current.snapshot.focusNode) : view.relations;
    const lines = [
      `Focus: ${this.title(current.snapshot.focusNode)} | Lens: ${current.snapshot.lensValue.toFixed(1)} | threshold: ${view.threshold.toFixed(3)} | ${view.status}`,
      all ? `All ${this.service.capabilities.semantic === 'not-configured' ? 'deterministic relations' : 'recalled relations'}: ${relations.length} (not filtered by Lens)`
        : `Visible: ${relations.length} | eligible: ${view.eligibleCount} | remaining: ${view.remainingCount} | pinned: ${view.pinnedCount}`,
    ];
    if (view.reasons.length) lines.push(`State: ${view.reasons.join(', ')}; use refresh to rebuild candidates.`);
    relations.forEach((relation, i) => {
      const neighbor = relation.nodes.find(id => id !== current.snapshot.focusNode)!;
      lines.push(`${i + 1}. ${this.title(neighbor)} | ${relation.score.toFixed(3)} | ${[...new Set(relation.signals.map(s => s.kind))].join('+')}${relation.override.pinned ? ' | pinned' : ''}`);
    });
    return lines.join('\n');
  }
  execute(line: string): { output: string; quit?: boolean } {
    const match = line.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match || line.trim().startsWith('#')) return { output: '' };
    const command = match[1]!.toLowerCase(), argument = match[2]?.trim() ?? '';
    switch (command) {
      case 'focus': this.session.focus(this.resolve(argument)); return { output: this.printRelations() };
      case 'lens': {
        if (!argument) throw new KernelError('INVALID_INPUT', 'lens <0..100>');
        const before = new Set(this.session.visible().relations.map(r => r.id));
        const after = this.session.setLens(Number(argument));
        return { output: `${this.printRelations()}\nNewly visible: ${after.relations.filter(r => !before.has(r.id)).length}` };
      }
      case 'relations': return { output: this.printRelations(argument === 'all') };
      case 'more': this.session.loadMore(argument ? Number(argument) : 40); return { output: this.printRelations() };
      case 'refresh': this.session.refresh(); return { output: this.printRelations() };
      case 'back': return { output: this.session.back() ? this.printRelations() : 'No earlier focus.' };
      case 'read': {
        const id = argument ? this.resolve(argument) : this.session.current?.snapshot.focusNode;
        if (!id) throw new KernelError('NOT_FOUND', 'Use focus first or specify a document');
        return { output: this.service.getNode(id)!.markdown };
      }
      case 'evidence': {
        const current = this.session.current;
        if (!current) throw new KernelError('NOT_FOUND', 'Use focus first');
        const visible = this.session.visible().relations;
        const relation = /^\d+$/.test(argument) ? visible[Number(argument) - 1]
          : this.service.getRelations(current.snapshot.focusNode).find(r => r.nodes.includes(this.resolve(argument)));
        if (!relation) throw new KernelError('NOT_FOUND', 'No such relation; use evidence <row number or target>');
        return { output: [`Score: ${relation.score.toFixed(3)} | rule: ${relation.scoreVersion} | semantic: ${relation.components.semantic.status}`,
          ...relation.signals.flatMap(signal => [
            signal.kind === 'semantic' ? `semantic: ${this.title(signal.from)} ↔ ${this.title(signal.to)} (cosine ${signal.rawValue.toFixed(4)}; model similarity, not a causal claim)`
              : `${signal.kind}: ${this.title(signal.from)} → ${this.title(signal.to)} (${signal.rawValue} occurrences)`,
            ...signal.evidence.map(locator => {
              const evidence = this.service.getEvidence(locator);
              return `  ${evidence.status} ${evidence.path ?? locator.documentId}@${locator.revision} UTF-16 [${locator.start}, ${locator.end})\n  ${JSON.stringify(evidence.text)}`;
            }),
          ])].join('\n') };
      }
      case 'hide': case 'unhide': case 'pin': case 'unpin': {
        const focus = this.session.current?.snapshot.focusNode;
        if (!focus) throw new KernelError('NOT_FOUND', 'Use focus first');
        this.service.setRelationOverride(focus, this.resolve(argument), command.includes('hide') ? { hidden: command === 'hide' } : { pinned: command === 'pin' });
        return { output: this.printRelations() };
      }
      case 'nodes': return { output: this.service.listDocuments().map(doc => `${doc.parsed.title}\t${doc.path}`).join('\n') };
      case 'status': return { output: `Documents: ${this.service.listDocuments().length} | indexRevision: ${this.service.indexRevision} | semantic: ${this.service.capabilities.semantic}` };
      case 'coverage': return { output: JSON.stringify(this.service.getEmbeddingCoverage(), null, 2) };
      case 'help': return { output: 'focus <name/path/id> | lens <0..100> | relations [all] | evidence <row/name> | more [count] | back | refresh | read [name] | hide/unhide/pin/unpin <name> | index [name/all] | coverage | nodes | status | quit' };
      case 'quit': case 'exit': return { output: 'Bye.', quit: true };
      default: throw new KernelError('INVALID_INPUT', `Unknown command: ${command}; use help`);
    }
  }
}
