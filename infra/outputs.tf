output "lb_public_ip" {
  description = "Cloudflare の DNS（A レコード、プロキシ有効）に設定する IP"
  value       = oci_load_balancer_load_balancer.lb.ip_address_details[0].ip_address
}

output "image_url" {
  description = "docker push 先"
  value       = local.image_url
}

output "container_instance_id" {
  value = oci_container_instances_container_instance.app.id
}
