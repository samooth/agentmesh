declare module "hypercore-crypto" {
  export type KeyPair = {
    publicKey: Buffer
    secretKey: Buffer
  }
  export function keyPair(seed?: Buffer): KeyPair
  export function validateKeyPair(keyPair: KeyPair): boolean
  export function sign(message: Buffer, secretKey: Buffer): Buffer
  export function verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean
  export function randomBytes(length: number): Buffer
  export function discoveryKey(publicKey: Buffer): Buffer
  export function hash(data: Buffer): Buffer
}
