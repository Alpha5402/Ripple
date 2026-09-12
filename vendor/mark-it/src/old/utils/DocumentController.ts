import { LineModel } from "../types"
import { tokenize } from "../tokenize"


export class DocumentController {
  private lines: LineModel[]

  constructor() {
    this.lines = []  
  }

  update(text: string): LineModel[] {
    const newLines = tokenize(this.lines, text)
    this.lines = newLines
    return newLines
  }

  getLines() {
    return this.lines
  }
  
  private getIndex(id: string) {
    return parseInt(id, 10);
  }

  getLineById(id: string) {
    const index = this.getIndex(id)
    if (index === null) 
      return null
    return this.lines[index]
  }

  updateLine(id: string, raw: string) {
    const index = this.getIndex(id)
    if (index === null) 
      return null

    this.lines[index].raw = raw
  }

  insertLineAfter(id: string, raw: string) {
    const index = this.getIndex(id)
    if (index === null) 
      return null

    const newLine: LineModel = {
      id: index + 1,   // 你已有 or 即将有
      indent: 0,
      leadingSpaces: 0,
      raw
    }

    this.lines.splice(index + 1, 0, newLine)
    this.lines.forEach(line => {
      if (line.id >= index)
        line.id++
    })
    return newLine
  }
}
