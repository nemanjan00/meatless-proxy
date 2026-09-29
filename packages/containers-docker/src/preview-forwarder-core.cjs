'use strict'
/*
 * The live preview forwarder: a TCP forwarder that accepts connections on each exposed port and
 * pipes them to the same port of the environment's main container, and nowhere else. Plain
 * CommonJS with node built-ins only: this file runs in-process (tests) and, inlined as
 * PREVIEW_FORWARDER_SOURCE, as `node -e` in the sidecar. See preview-forwarder.ts.
 */
const net = require('node:net')

/**
 * @param {{ target: string, forwards: { listen: number, port: number }[] }} opts
 * @returns {{ listen: number, port: number, server: import('node:net').Server }[]}
 */
function createPreviewForwarder(opts) {
  return opts.forwards.map((f) => {
    // Half-open: a client that sends and then shuts down its side still gets the answer.
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      const upstream = net.connect({ host: opts.target, port: f.port, allowHalfOpen: true })
      client.pipe(upstream)
      upstream.pipe(client)
      const fail = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', fail)
      upstream.on('error', fail)
      // `pipe` passes each side's end on; once the client is fully closed nobody reads the answer.
      client.on('close', () => upstream.destroy())
    })
    return { listen: f.listen, port: f.port, server }
  })
}

module.exports = { createPreviewForwarder }
