import { ValidationError } from '@mp/core'

/** Plain, friendly adjectives: nothing that reads as a judgement of anyone. */
const ADJECTIVES = [
  'amber',
  'autumn',
  'brave',
  'breezy',
  'bright',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'dapper',
  'eager',
  'gentle',
  'golden',
  'happy',
  'honest',
  'jolly',
  'kind',
  'lively',
  'lucky',
  'mellow',
  'misty',
  'nimble',
  'ordinary',
  'patient',
  'plucky',
  'quiet',
  'rapid',
  'rosy',
  'silver',
  'sleepy',
  'snowy',
  'steady',
  'sunny',
  'swift',
  'tidy',
  'velvet',
  'witty',
] as const

/** Fruit, plants, animals and things: short and easy to type. */
const NOUNS = [
  'acorn',
  'badger',
  'basil',
  'beacon',
  'berry',
  'cedar',
  'clover',
  'comet',
  'falcon',
  'fern',
  'fig',
  'finch',
  'garnet',
  'harbor',
  'heron',
  'kiwi',
  'lantern',
  'lemon',
  'lynx',
  'maple',
  'meadow',
  'mango',
  'otter',
  'pebble',
  'pepper',
  'pine',
  'plum',
  'quartz',
  'raven',
  'river',
  'robin',
  'sparrow',
  'thistle',
  'tulip',
  'walnut',
  'willow',
  'wren',
  'yarrow',
] as const

/** A random `adjective-noun` name, e.g. `ordinary-plum`. `random` returns a number in [0, 1). */
export function randomAgentName(random: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * A chosen agent name, normalised: a slug of 3 to 30 lowercase letters, digits
 * and single hyphens, starting with a letter. A leading `@` is dropped.
 * `ValidationError` otherwise.
 */
export function agentName(raw: string): string {
  const n = String(raw ?? '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
  if (n.length < 3 || n.length > 30 || !NAME_RE.test(n))
    throw new ValidationError(
      'an agent name is 3 to 30 lowercase letters, digits and single hyphens, starting with a letter (e.g. ordinary-plum)',
      [n],
    )
  return n
}
