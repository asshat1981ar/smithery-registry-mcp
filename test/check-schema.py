"""Validate actual server outputs against the pinned upstream schema, not local types.
Optional prerequisite: Python jsonschema (Draft 2020-12).
"""
import json
from pathlib import Path
import subprocess
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent.parent
schema = json.loads((root / 'test/fixtures/tasks-2026-07-28.schema.json').read_text())
source = r'''
import { StdioTaskServer, TASKS_EXTENSION } from './dist/task-server.js';
import { RegistryClient } from './dist/registry.js';
import { SNAPSHOT_TOOL } from './dist/snapshot.js';
import { setImmediate as tick } from 'node:timers/promises';
const server = new StdioTaskServer(new RegistryClient('https://test.invalid', async () => new Response(JSON.stringify({servers: []}))));
const call = async (method, params = {}) => {
  const request = {jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{extensions:{[TASKS_EXTENSION]:{}}}}}};
  const reply = await server.handle(request);
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return reply.result;
};
try {
  const created = await call('tools/call',{name:'registry_snapshot',arguments:{max_pages:1}});
  const working = await call('tasks/get',{taskId:created.taskId});
  let final;
  for(let i=0;i<20;i++) { await tick(); final=await call('tasks/get',{taskId:created.taskId}); if(final.status!=='working') break; }
  if(final.status!=='completed') throw new Error('Task not complete');
  const updated=await call('tasks/update',{taskId:created.taskId,inputResponses:{}});
  const cancelled=await call('tasks/cancel',{taskId:created.taskId});
  const second=await call('tools/call',{name:'registry_snapshot',arguments:{}});
  await call('tasks/cancel',{taskId:second.taskId});
  const cancelledTask=await call('tasks/get',{taskId:second.taskId});
  console.log(JSON.stringify({cases:[['CreateTaskResult',created],['GetTaskResult',working],['GetTaskResult',final],['UpdateTaskResult',updated],['CancelTaskResult',cancelled],['GetTaskResult',cancelledTask]],outputSchema:SNAPSHOT_TOOL.outputSchema,output:final.result.structuredContent}));
} finally {server.close();}
'''
result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=root, capture_output=True, text=True, check=True, timeout=10)
transcript = json.loads(result.stdout)
for kind, value in transcript['cases']:
    validator = Draft202012Validator({**schema, '$ref': f'#/$defs/{kind}'})
    validator.validate(value)
Draft202012Validator.check_schema(transcript['outputSchema'])
Draft202012Validator(transcript['outputSchema']).validate(transcript['output'])
print(f"PASS: {len(transcript['cases'])} task responses against upstream 2026-07-28 schema; snapshot output against advertised schema")
