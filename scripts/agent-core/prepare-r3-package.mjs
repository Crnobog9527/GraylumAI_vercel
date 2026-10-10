/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only packaging. Input is a private read-only export {manifest, files:[{path,base64}]}.
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const {parseDocument} = require('yaml');
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error('Usage: node prepare-r3-package.mjs <private-export.json> <new-private-directory>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
if (source.manifest.revisionId !== '78c3d0a4-7c9f-4956-ac2d-028cf293f086' ||
    source.manifest.packageHash !== '17e0d061bba369caf295674579cca7b20b7e816723f0edde02ff16e9dfa2cba2')
  throw new Error('Expected the verified published positioning v11 export');
const templatePath = 'assets/organizer-template.md';
const template = [
  '# 定位信息整理模板',
  '',
  '按本次 checklist 声明的栏目和字段说明整理，不按当前提问顺序限制信息归属。',
  '将用户背景、业务目标、目标受众、内容方向、平台、执行资源和商业计划分别归入其对应字段。',
  '同一回答涉及多个栏目时分开整理；已有信息合并为完整值，保留限制、时间范围和不确定性。',
  '对标账号及数据必须来自提供的材料；缺少的保持未知，不根据常识编造。',
  '导师建议与用户事实分别保留来源；用户未采纳的假设不能写成用户已确认的决定。',
  '本模板只补充整理方式。遵守宿主的字段白名单、输出格式、长度和受保护字段规则；不自动确认或推进步骤。',
  '',
].join('\n');
const files = source.files.map(file => ({path: file.path, bytes: Buffer.from(file.base64, 'base64')}));
if (files.length !== source.manifest.files.length || new Set(files.map(file => file.path)).size !== files.length)
  throw new Error('Invalid source inventory');
for (const file of files) {
  const declared = source.manifest.files.find(item => item.path === file.path);
  if (!declared || declared.bytes !== file.bytes.length || declared.sha256 !== hash(file.bytes))
    throw new Error('Source integrity mismatch');
  if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..'))
    throw new Error('Invalid source path');
}
const workflow = files.find(file => file.path === 'workflow.yaml');
if (!workflow || files.some(file => file.path === templatePath)) throw new Error('Unexpected source package');
const text = new TextDecoder('utf-8', {fatal: true}).decode(workflow.bytes);
const document = parseDocument(text, {uniqueKeys: true});
const prior = document.toJS({maxAliasCount: 0});
if (document.errors.length || document.warnings.length || prior.organizerTemplate !== undefined)
  throw new Error('Unexpected workflow declaration');
// Published workflow.yaml may use a JSON-style flow map. Insert only the new property.
let updated;
if (document.contents?.flow) {
  const closing = text.lastIndexOf('}');
  if (closing < 0) throw new Error('Invalid flow-map manifest');
  updated = text.slice(0, closing) + `,\n"organizerTemplate": "${templatePath}"\n` + text.slice(closing);
} else {
  updated = text + `${text.endsWith('\n') ? '' : '\n'}organizerTemplate: ${templatePath}\n`;
}
const updatedDocument = parseDocument(updated, {uniqueKeys: true});
if (updatedDocument.errors.length || updatedDocument.warnings.length) throw new Error('Invalid generated manifest');
workflow.bytes = Buffer.from(updated);
const changed = updatedDocument.toJS({maxAliasCount: 0});
if (changed.organizerTemplate !== templatePath) throw new Error('Missing generated declaration');
delete changed.organizerTemplate;
if (JSON.stringify(changed) !== JSON.stringify(prior)) throw new Error('Workflow semantics changed');
files.push({path: templatePath, bytes: Buffer.from(template)});
const output = resolve(outputPath);
await mkdir(output, {mode: 0o700}); // Existing output is an error; never overwrite another package.
const directory = join(output, source.manifest.directoryName);
const proof = {sourceRevision: source.manifest.revisionId, sourcePackageHash: source.manifest.packageHash,
  sourceVersion: 11, sourceFiles: source.files.length, outputFiles: files.length,
  changed: ['workflow.yaml'], added: [templatePath], unchanged: [], files: []};
for (const file of files) {
  const target = join(directory, file.path);
  await mkdir(resolve(target, '..'), {recursive: true, mode: 0o700});
  await writeFile(target, file.bytes, {mode: 0o600, flag: 'wx'});
  const original = source.files.find(item => item.path === file.path);
  if (original && file.path !== 'workflow.yaml') {
    if (!file.bytes.equals(Buffer.from(original.base64, 'base64'))) throw new Error('Original content changed');
    proof.unchanged.push(file.path);
  }
  proof.files.push({path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes)});
}
await writeFile(join(output, 'verification.json'), JSON.stringify(proof, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({sourceVersion: 11, sourceFiles: proof.sourceFiles, outputFiles: proof.outputFiles,
  unchangedFiles: proof.unchanged.length, changed: proof.changed, added: proof.added}));
