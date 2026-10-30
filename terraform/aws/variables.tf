variable "aws_region" {
  description = "AWS Region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name identifier used for tagging and resource naming"
  type        = string
  default     = "repo2cloud"
}

variable "ecs_cluster_name" {
  description = "Name of the ECS Cluster"
  type        = string
  default     = "repo2cloud-cluster"
}

variable "domain_name" {
  description = "Optional Route 53 domain name (e.g. maas-fam.com)"
  type        = string
  default     = "maas-fam.com"
}
