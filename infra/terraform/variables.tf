variable "aws_region" {
  description = "Primary AWS region for Repo2Cloud S3 buckets and resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name (e.g., hackathon, dev, prod)"
  type        = string
  default     = "hackathon"
}

variable "s3_bucket_prefix" {
  description = "Prefix for private S3 buckets created by Repo2Cloud static deployments"
  type        = string
  default     = "repo2cloud-static"
}

variable "create_deployer_iam_user" {
  description = "Whether to create a dedicated least-privilege IAM user for local Express backend execution"
  type        = bool
  default     = true
}

# ============================================================================
# Phase 2 Variables: Custom Subdomains with Route 53 + ACM (us-east-1)
# ============================================================================
variable "route53_hosted_zone_id" {
  description = "Optional existing Route 53 Hosted Zone ID (e.g., Z0123456789ABCDEF) for custom subdomains"
  type        = string
  default     = ""
}

variable "root_domain_name" {
  description = "Optional root domain name registered in Route 53 (e.g., yourdomain.com) to provision a wildcard ACM certificate in us-east-1"
  type        = string
  default     = ""
}
