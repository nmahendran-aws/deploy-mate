data "aws_caller_identity" "current" {}

# CloudFront requires ACM certificates to be provisioned in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# ============================================================================
# Phase 1 & 2 Foundation: Least-Privilege IAM Policy (S3 + CloudFront + Route 53 + ACM)
# ============================================================================
data "aws_iam_policy_document" "repo2cloud_deployer" {
  statement {
    sid    = "ManageRepo2CloudPrivateS3Buckets"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:ListBucket",
      "s3:PutBucketPolicy",
      "s3:GetBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketTagging"
    ]
    resources = [
      "arn:aws:s3:::${var.s3_bucket_prefix}-*"
    ]
  }

  statement {
    sid    = "ManageRepo2CloudStaticAssets"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject"
    ]
    resources = [
      "arn:aws:s3:::${var.s3_bucket_prefix}-*/*"
    ]
  }

  statement {
    sid    = "ManageCloudFrontOACAndDistributions"
    effect = "Allow"
    actions = [
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:CreateDistribution",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:TagResource"
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManagePhase2Route53SubdomainRecords"
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:GetChange",
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets"
    ]
    resources = [
      var.route53_hosted_zone_id != "" ? "arn:aws:route53:::hostedzone/${var.route53_hosted_zone_id}" : "arn:aws:route53:::hostedzone/*",
      "arn:aws:route53:::change/*"
    ]
  }

  statement {
    sid    = "ManagePhase2AcmCertificatesInUsEast1"
    effect = "Allow"
    actions = [
      "acm:RequestCertificate",
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "acm:DeleteCertificate",
      "acm:AddTagsToCertificate"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "phase1_deployer_policy" {
  name        = "repo2cloud-${var.environment}-s3-cf-route53-acm-policy"
  description = "Least-privilege policy for Repo2Cloud Phase 1 & 2 (S3, CloudFront OAC, Route 53, ACM)"
  policy      = data.aws_iam_policy_document.repo2cloud_deployer.json
}

resource "aws_iam_user" "deployer" {
  count = var.create_deployer_iam_user ? 1 : 0
  name  = "repo2cloud-${var.environment}-deployer"
}

resource "aws_iam_user_policy_attachment" "deployer_attach" {
  count      = var.create_deployer_iam_user ? 1 : 0
  user       = aws_iam_user.deployer[0].name
  policy_arn = aws_iam_policy.phase1_deployer_policy.arn
}

data "aws_iam_policy_document" "ec2_ecs_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com", "ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "deployer_role" {
  name               = "repo2cloud-${var.environment}-deployer-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "deployer_role_attach" {
  role       = aws_iam_role.deployer_role.name
  policy_arn = aws_iam_policy.phase1_deployer_policy.arn
}

# ============================================================================
# Phase 2 Optional Wildcard ACM Certificate in us-east-1 + Route 53 Validation
# ============================================================================
resource "aws_acm_certificate" "wildcard" {
  count                     = var.root_domain_name != "" && var.route53_hosted_zone_id != "" ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = "*.${var.root_domain_name}"
  subject_alternative_names = [var.root_domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "wildcard_validation" {
  for_each = var.root_domain_name != "" && var.route53_hosted_zone_id != "" ? {
    for dvo in aws_acm_certificate.wildcard[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_hosted_zone_id
}

resource "aws_acm_certificate_validation" "wildcard" {
  count                   = var.root_domain_name != "" && var.route53_hosted_zone_id != "" ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.wildcard[0].arn
  validation_record_fqdns = [for record in aws_route53_record.wildcard_validation : record.fqdn]
}
