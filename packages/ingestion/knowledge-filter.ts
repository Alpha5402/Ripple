import ignore from 'ignore';

export const MAX_IGNORE_RULES_LENGTH = 32_768;
/** Rules use vault-relative POSIX paths and gitignore ordering/parent-directory semantics. */
export function knowledgeFilter(rules = '') {
  if (typeof rules !== 'string' || rules.length > MAX_IGNORE_RULES_LENGTH || rules.includes('\0')) throw new Error('排除规则无效或过长');
  const matcher = ignore({ ignorecase: false }).add(rules);
  return (path: string, directory = false): boolean => {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '')) throw new Error('排除规则只能匹配工作区内的相对路径');
    return matcher.ignores(normalized + (directory ? '/' : ''));
  };
}
