import { readFileSync } from 'node:fs'
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js'

const buf = readFileSync(`${process.env.HOME}/.dsh/storages/dsh-virtual-companion/models/ganyu/model.pmx`)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

for (const [label, ltr] of [['raw(不翻X, babylon-mmd)', false], ['翻X(MMDLoader/three)', true]]) {
  const pmx = new MMDParser.Parser().parsePmx(ab, ltr)
  const pick = pmx.materials.findIndex(m => m.name === '面1')
  let triOffset = 0
  for (let i = 0; i < pick; i++) triOffset += pmx.materials[i].faceCount
  const faceCount = pmx.materials[pick].faceCount
  const acc = { x: 0, y: 0, z: 0 }
  for (let t = 0; t < faceCount; t++) {
    for (const i of pmx.faces[triOffset + t].indices) {
      const n = pmx.vertices[i].normal
      acc.x += n[0]/3; acc.y += n[1]/3; acc.z += n[2]/3
    }
  }
  const len = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2)
  console.log(`${label}: 面1法线 (${(acc.x/len).toFixed(3)}, ${(acc.y/len).toFixed(3)}, ${(acc.z/len).toFixed(3)})`)
}
