import * as stdlib from '@mp/stdlib'

/** The standard library: the model's tools, the employee prompt and the built-in policies. */
export type StdlibModule = typeof stdlib

/** The standard library module (a function, so the composition root can leave it out). */
export async function loadStdlib(): Promise<StdlibModule> {
  return stdlib
}
