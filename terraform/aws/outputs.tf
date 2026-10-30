output "vpc_id" {
  description = "VPC ID to set in ECS_VPC_ID"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Subnet IDs to set in ECS_PRIVATE_SUBNET_IDS (comma-separated)"
  value       = "${aws_subnet.public_1.id},${aws_subnet.public_2.id}"
}

output "alb_arn" {
  description = "ALB ARN to set in ECS_ALB_ARN"
  value       = aws_lb.main.arn
}

output "alb_listener_arn" {
  description = "ALB HTTP 80 Listener ARN to set in ECS_ALB_LISTENER_ARN"
  value       = aws_lb_listener.http.arn
}

output "alb_dns_name" {
  description = "ALB DNS Name to set in ECS_ALB_DNS_NAME"
  value       = aws_lb.main.dns_name
}

output "ecs_cluster_name" {
  description = "ECS Cluster Name to set in ECS_CLUSTER_NAME"
  value       = aws_ecs_cluster.main.name
}

output "ecs_execution_role_arn" {
  description = "ECS Execution Role ARN to set in ECS_EXECUTION_ROLE_ARN"
  value       = aws_iam_role.ecs_execution_role.arn
}

output "ecs_task_role_arn" {
  description = "ECS Task Role ARN to set in ECS_TASK_ROLE_ARN"
  value       = aws_iam_role.ecs_task_role.arn
}
