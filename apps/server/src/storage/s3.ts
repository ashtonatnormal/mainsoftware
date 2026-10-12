// The S3 client. In AWS it uses the task role's credentials and S3's own endpoint; locally it
// points at the Compose stack's S3-compatible store (S3_ENDPOINT, path-style URLs), with the
// AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY the SDK reads from the environment.
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { Config } from '#src/config.ts'
import type { Check } from '#src/ready.ts'

export function createS3(s3: Config['s3']): S3Client {
  return new S3Client({
    region: s3.region,
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    forcePathStyle: s3.forcePathStyle,
  })
}

export function storageCheck(client: S3Client, bucket: string): Check {
  return async signal => {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal })
  }
}
