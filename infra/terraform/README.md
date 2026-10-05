# Terraform (skeleton, not applied)

Nothing here has been applied to any AWS account. The target layout from the Architecture Plan:

- `network`: VPC with private subnets, no public database endpoints, VPC endpoints for S3/KMS/SQS/Secrets Manager.
- `data`: RDS PostgreSQL 16 (encrypted, Multi-AZ, PITR), run `db/bootstrap.sql` once as the master user.
- `storage`: S3 bucket for clinical media (SSE-KMS, versioning, object lock for signed media, no public access).
- `keys`: KMS keys for field encryption and an asymmetric ECC key for record signing.
- `compute`: ECS Fargate services for the API and the outbox worker; ALB with WAF.
- `identity`: Cognito user pool with TOTP MFA required.
- `observability`: CloudWatch logs (PHI-scrubbed app logs only), CloudTrail, GuardDuty.

Only HIPAA-eligible services under a signed AWS BAA.
