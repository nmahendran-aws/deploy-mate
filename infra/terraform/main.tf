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

  statement {
    sid    = "ManagePhase4EcrAndEcsFargate"
    effect = "Allow"
    actions = [
      "ecr:CreateRepository",
      "ecr:DeleteRepository",
      "ecr:DescribeRepositories",
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecs:CreateCluster",
      "ecs:DescribeClusters",
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:CreateService",
      "ecs:UpdateService",
      "ecs:DeleteService",
      "ecs:DescribeServices",
      "elasticloadbalancing:CreateTargetGroup",
      "elasticloadbalancing:DeleteTargetGroup",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:CreateRule",
      "elasticloadbalancing:DeleteRule",
      "elasticloadbalancing:DescribeRules",
      "iam:PassRole"
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManagePhase5LambdaAndApiGatewayV2"
    effect = "Allow"
    actions = [
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:AddPermission",
      "lambda:RemovePermission",
      "apigateway:POST",
      "apigateway:GET",
      "apigateway:DELETE",
      "apigateway:PATCH",
      "iam:GetRole",
      "iam:CreateRole",
      "iam:AttachRolePolicy",
      "iam:PassRole"
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManagePhase6AwsAmplifyHosting"
    effect = "Allow"
    actions = [
      "amplify:CreateApp",
      "amplify:DeleteApp",
      "amplify:GetApp",
      "amplify:ListApps",
      "amplify:CreateBranch",
      "amplify:DeleteBranch",
      "amplify:GetBranch",
      "amplify:CreateDeployment",
      "amplify:StartDeployment",
      "amplify:CreateDomainAssociation",
      "amplify:DeleteDomainAssociation",
      "amplify:GetDomainAssociation"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "phase1_deployer_policy" {
  name        = "repo2cloud-${var.environment}-s3-cf-route53-acm-ecs-lambda-amplify-policy"
  description = "Least-privilege policy for Repo2Cloud Phases 1–6 (S3, CloudFront OAC, Route 53, ACM, ECR, ECS Fargate, ALB, Lambda, API Gateway v2, Amplify)"
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
# Phase 4 Foundation: ECS Fargate Cluster & Task Execution Role
# ============================================================================
resource "aws_ecs_cluster" "repo2cloud" {
  name = "repo2cloud-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "ecs_task_execution_role" {
  name               = "repo2cloud-${var.environment}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_role_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "ecs_fargate" {
  name              = "/ecs/repo2cloud-fargate"
  retention_in_days = 14
}

# ============================================================================
# Phase 5 Foundation: AWS Lambda Execution Role
# ============================================================================
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_execution_role" {
  name               = "repo2cloud-lambda-exec-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ============================================================================
# Phase 6 Foundation: AWS Amplify Compute Service Role
# ============================================================================
data "aws_iam_policy_document" "amplify_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["amplify.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "amplify_service_role" {
  name               = "repo2cloud-${var.environment}-amplify-service-role"
  assume_role_policy = data.aws_iam_policy_document.amplify_assume_role.json
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
