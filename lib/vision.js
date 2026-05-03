/**
 * @file lib/vision.js
 * @description Pure helpers for detecting image (vision) capability on models
 * and image content on chat completion requests.
 */

export const VISION_NAME_HEURISTIC = /(^|[-/_:])(vl|vision|omni|multimodal|mm)(?=[-:_/]|$)/i

export function isVisionModelByName(modelId) {
  if (typeof modelId !== 'string' || !modelId) return false
  return VISION_NAME_HEURISTIC.test(modelId)
}

export function extractOpenRouterVisionFlag(record) {
  if (!record || typeof record !== 'object') return null
  const arch = record.architecture || record.arch || null
  if (arch && Array.isArray(arch.input_modalities)) {
    return arch.input_modalities.some(m => typeof m === 'string' && m.toLowerCase() === 'image')
  }
  if (arch && typeof arch.modality === 'string') {
    return /image/i.test(arch.modality)
  }
  if (typeof record.modality === 'string') {
    return /image/i.test(record.modality)
  }
  return null
}

export function extractOllamaVisionFlag(record) {
  if (!record || typeof record !== 'object') return null
  if (Array.isArray(record.capabilities)) {
    return record.capabilities.some(c => typeof c === 'string' && c.toLowerCase() === 'vision')
  }
  return null
}

function partLooksLikeImage(part) {
  if (!part || typeof part !== 'object') return false
  const t = typeof part.type === 'string' ? part.type.toLowerCase() : ''
  if (t === 'image_url' || t === 'image' || t === 'input_image') return true
  if (part.image_url) return true
  if (part.image && typeof part.image === 'object') return true
  return false
}

export function messagesContainImageContent(messages) {
  if (!Array.isArray(messages)) return false
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (partLooksLikeImage(part)) return true
    }
  }
  return false
}

export function redactImageContentInMessages(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map(msg => {
    if (!msg || !Array.isArray(msg.content)) return msg
    if (!msg.content.some(partLooksLikeImage)) return msg
    return {
      ...msg,
      content: msg.content.map(part =>
        partLooksLikeImage(part)
          ? { type: 'image_url', image_url: { url: '[image redacted]' } }
          : part
      ),
    }
  })
}
