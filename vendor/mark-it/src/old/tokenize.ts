// src/core/state.ts
import { LineModel } from './types';

let _idSeed = 0;

const uid = () => {
  return `${_idSeed++}`
}

export function tokenize(oldLines: LineModel[], newText: string): LineModel[] {
  const raws = newText.split('\n')

  return raws.map((raw, index) => {
    
    const old = oldLines[index]
    let indent = 0
    
    const leadingMatch = raw.match(/^[ \t]*/)?.[0] ?? '';
    for (const char of leadingMatch) {
      if (char === '\t') {
        indent += 2;
      } else {
        indent += 0.5;
      }
    }

    return {
      id: old?.id ?? uid(),
      indent: indent,
      leadingSpaces: old?.leadingSpaces ?? 0,
      raw
    }
  })
}