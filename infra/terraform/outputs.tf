output "aws_account_id" {
  description = "Active AWS Account ID"
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "Configured AWS Region"
  value       = var.aws_region
}

output "s3_bucket_prefix" {
  description = "Configured S3 bucket prefix for static site deployments"
  value       = var.s3_bucket_prefix
}

output "deployer_iam_policy_arn" {
  description = "ARN of the least-privilege IAM policy for Phase 1 & 2 deployments"
  value       = aws_iam_policy.phase1_deployer_policy.arn
}

output "deployer_iam_role_arn" {
  description = "ARN of the IAM role for Phase 1 & 2 deployments"
  value       = aws_iam_role.deployer_role.arn
}

output "wildcard_acm_certificate_arn" {
  description = "Validated wildcard ACM certificate ARN in us-east-1 (when root_domain_name is provided)"
  value       = var.root_domain_name != "" && var.route53_hosted_zone_id != "" ? aws_acm_certificate_validation.wildcard[0].certificate_arn : null
}

output "configured_domains_env_value" {
  description = "Ready-to-paste CONFIGURED_DOMAINS value for .env"
  value       = var.root_domain_name != "" && var.route53_hosted_zone_id != "" ? "${var.root_domain_name}:${var.route53_hosted_zone_id}:${aws_acm_certificate_validation.wildcard[0].certificate_arn}" : null
}

output "ecs_cluster_name" {
  description = "Phase 4 ECS Fargate cluster name"
  value       = aws_ecs_cluster.repo2cloud.name
}

output "ecs_task_execution_role_arn" {
  description = "Phase 4 ECS Fargate task execution role ARN"
  value       = aws_iam_role.ecs_task_execution_role.arn
}

output "lambda_execution_role_arn" {
  description = "Phase 5 AWS Lambda execution role ARN"
  value       = aws_iam_role.lambda_execution_role.arn
}

output "amplify_service_role_arn" {
  description = "Phase 6 AWS Amplify compute service role ARN"
  value       = aws_iam_role.amplify_service_role.arn
}

