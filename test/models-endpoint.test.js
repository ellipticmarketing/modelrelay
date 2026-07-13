/**
 * Integration tests for GET /v1/models — dual-protocol endpoint.
 *
 * Tests that the route returns the correct format depending on:
 *  - OpenAI clients (no anthropic-version header) → OpenAI format
 *  - Anthropic clients (anthropic-version header present) → Anthropic format
 *
 * NOTE: This mirrors the route logic from lib/server.js lines 3665-3694.
 * The real route handler is inside runServer's closure and not directly
 * exported, so we replicate it in the test app to verify both branches.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildModelGroups } from '../lib/utils.js'
import { canonicalizeModelId } from '../sources.js'
import { buildAnthropicModelsList } from '../lib/anthropic-adapter.js'

/**
 * Build an Express app with just the /v1/models route, mirroring
 * the logic from runServer() in lib/server.js.
 */
function createModelsApp(mockResults) {
  const app = express()

  app.get('/v1/models', (req, res) => {
    // Anthropic branch: anthropic-version header present
    if (req.headers['anthropic-version']) {
      return res.json(buildAnthropicModelsList())
    }

    // OpenAI branch: no anthropic-version header
    const groups = buildModelGroups(mockResults, canonicalizeModelId)
    const data = [
      {
        id: 'auto-fastest',
        name: 'Auto Fastest',
        object: 'model',
        created: Date.now(),
        owned_by: 'router',
      },
      ...groups.map(group => ({
        id: group.id,
        name: group.label,
        object: 'model',
        created: Date.now(),
        owned_by: 'relay',
      })),
    ]

    res.json({ object: 'list', data })
  })

  return app
}

/** Stub model results — mirrors what runServer() builds internally. */
const MOCK_RESULTS = [
  { modelId: 'nvidia/llama-3.1-8b-instruct', label: 'Llama 3.1 8B',      providerKey: 'nvidia', intell: 10, ctx: '128k', idx: 1, status: 'up', pings: [] },
  { modelId: 'openai/gpt-4o-mini',           label: 'GPT-4o Mini',       providerKey: 'openai', intell: 9,  ctx: '128k', idx: 2, status: 'up', pings: [] },
  { modelId: 'anthropic/claude-sonnet-4-5',  label: 'Claude Sonnet 4.5', providerKey: 'anthropic', intell: 8, ctx: '200k', idx: 3, status: 'up', pings: [] },
]

describe('GET /v1/models — protocol-specific responses', () => {
  let server, port

  before(() => {
    const app = createModelsApp(MOCK_RESULTS)
    return new Promise(resolve => {
      server = app.listen(0, () => {
        port = server.address().port
        resolve()
      })
    })
  })

  after(() => {
    if (server) server.close()
  })

  /* ─── OpenAI protocol (no anthropic-version header) ─── */

  it('returns 200 with object=list for OpenAI clients', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.object, 'list')
    assert.ok(Array.isArray(body.data))
  })

  it('includes auto-fastest as first model for OpenAI clients', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`)
    const body = await res.json()
    assert.equal(body.data[0].id, 'auto-fastest')
    assert.equal(body.data[0].object, 'model')
    assert.equal(body.data[0].owned_by, 'router')
  })

  it('includes all mock results as relay models for OpenAI clients', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`)
    const body = await res.json()
    const relayModels = body.data.filter(m => m.owned_by === 'relay')
    assert.equal(relayModels.length, MOCK_RESULTS.length)
    assert.ok(relayModels.some(m => m.id.includes('llama')))
    assert.ok(relayModels.some(m => m.id.includes('gpt')))
    assert.ok(relayModels.some(m => m.id.includes('claude')))
  })

  it('OpenAI models have required fields', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`)
    const body = await res.json()
    for (const model of body.data) {
      assert.ok(typeof model.id === 'string', `model.id must be string, got ${typeof model.id}`)
      assert.ok(typeof model.name === 'string', `model.name must be string, got ${typeof model.name}`)
      assert.equal(model.object, 'model')
      assert.ok(typeof model.created === 'number', `model.created must be number, got ${typeof model.created}`)
      assert.ok(['router', 'relay'].includes(model.owned_by), `unexpected owned_by: ${model.owned_by}`)
    }
  })

  /* ─── Anthropic protocol (anthropic-version header) ─── */

  it('returns 200 with Anthropic format for Anthropic clients', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    // Anthropic format has top-level "data" but no "object" field
    assert.equal(body.object, undefined)
    assert.ok(Array.isArray(body.data))
  })

  it('all Anthropic models have type=model and valid id', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    })
    const body = await res.json()
    assert.ok(body.data.length > 0)
    for (const model of body.data) {
      assert.equal(model.type, 'model')
      assert.ok(typeof model.id === 'string')
    }
  })

  it('returns exactly 3 Anthropic models (sonnet, haiku, opus)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    })
    const body = await res.json()
    const ids = body.data.map(m => m.id)
    assert.equal(body.data.length, 3)
    assert.ok(ids.includes('claude-sonnet-4-5'))
    assert.ok(ids.includes('claude-haiku-4-5'))
    assert.ok(ids.includes('claude-opus-4-5'))
  })

  it('Anthropic models do NOT include auto-fastest or relay models', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    })
    const body = await res.json()
    const ids = body.data.map(m => m.id)
    assert.ok(!ids.includes('auto-fastest'))
    assert.ok(!ids.some(id => id.includes('llama') || id.includes('gpt')))
  })

  /* ─── Edge cases ─── */

  it('treats empty anthropic-version header as OpenAI client (empty string is falsy)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '' },
    })
    const body = await res.json()
    assert.equal(body.object, 'list') // OpenAI format
    assert.equal(body.data[0].id, 'auto-fastest')
  })

  it('returns correct Content-Type for both protocols', async () => {
    const openaiRes = await fetch(`http://localhost:${port}/v1/models`)
    assert.ok(openaiRes.headers.get('content-type').includes('application/json'))

    const anthropicRes = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    })
    assert.ok(anthropicRes.headers.get('content-type').includes('application/json'))
  })
})
