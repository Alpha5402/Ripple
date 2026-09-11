import { KernelError, type UserDeclarations } from './model.js';

export function validateDeclarations(value: UserDeclarations): void {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.aliases) || !value.relations || Array.isArray(value.relations)
    || value.aliases.some(alias => !alias || typeof alias.name !== 'string' || !alias.name.trim()
      || typeof alias.target?.documentId !== 'string' || !alias.target.documentId
      || (alias.target.sectionId !== undefined && typeof alias.target.sectionId !== 'string')
      || (alias.allowShort !== undefined && typeof alias.allowShort !== 'boolean'))
    || Object.values(value.relations).some(override => !override || typeof override !== 'object'
      || (override.hidden !== undefined && typeof override.hidden !== 'boolean')
      || (override.pinned !== undefined && typeof override.pinned !== 'boolean')
      || (override.note !== undefined && typeof override.note !== 'string'))) {
    throw new KernelError('INVALID_INPUT', 'Invalid user declarations');
  }
}
