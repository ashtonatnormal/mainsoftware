// The S3 client. In AWS it uses the ECS task role's credentials and S3's own endpoint; locally it
// points at the Compose stack's S3-compatible store (S3_ENDPOINT, path-style URLs) with that
// store's dummy keys.
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { Config } from '#src/config.ts'
import type { Check } from '#src/ready.ts'

export function createS3(s3: Config['s3']): S3Client {
  return new S3Client({
    region: s3.region,
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    ...(s3.credentials ? { credentials: s3.credentials } : {}),
    forcePathStyle: s3.forcePathStyle,
    // Send and check checksums only where S3 requires them. With the SDK's default, presigned
    // upload URLs carry the CRC32 of an empty body, which S3 then holds the upload to.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

export function storageCheck(client: S3Client, bucket: string): Check {
  return async signal => {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal })
  }
}
