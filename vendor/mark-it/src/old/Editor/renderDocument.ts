// pipeline/renderDocument.ts
import { parseLine } from "../parser"
import { reconcile } from "./patch"
import { LineModel } from "../types"

export function renderDocument(
  root: HTMLElement,
  lines: LineModel[]
) {
  const blocks = lines.map(parseLine)
  reconcile(root, blocks, true)
}
