# Cloudflare（Full strict）→ LB（HTTPS、Cloudflare Origin CA 証明書）→ Container Instance:8080

resource "oci_load_balancer_load_balancer" "lb" {
  compartment_id             = var.compartment_ocid
  display_name               = "${var.name}-lb"
  shape                      = "flexible"
  subnet_ids                 = [oci_core_subnet.public.id]
  network_security_group_ids = [oci_core_network_security_group.lb.id]
  is_private                 = false
  shape_details {
    minimum_bandwidth_in_mbps = 10
    maximum_bandwidth_in_mbps = 10
  }
}

resource "oci_load_balancer_backend_set" "app" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  name             = "app"
  policy           = "ROUND_ROBIN"
  health_checker {
    protocol    = "HTTP"
    port        = 8080
    url_path    = "/healthz"
    return_code = 200
  }
}

resource "oci_load_balancer_backend" "app" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  backendset_name  = oci_load_balancer_backend_set.app.name
  ip_address       = var.app_private_ip
  port             = 8080
}

resource "oci_load_balancer_certificate" "origin" {
  load_balancer_id   = oci_load_balancer_load_balancer.lb.id
  certificate_name   = "cloudflare-origin"
  public_certificate = file(pathexpand(var.origin_cert_path))
  private_key        = file(pathexpand(var.origin_key_path))
  lifecycle {
    create_before_destroy = true
  }
}

resource "oci_load_balancer_listener" "https" {
  load_balancer_id         = oci_load_balancer_load_balancer.lb.id
  name                     = "https"
  default_backend_set_name = oci_load_balancer_backend_set.app.name
  port                     = 443
  protocol                 = "HTTP"
  ssl_configuration {
    certificate_name        = oci_load_balancer_certificate.origin.certificate_name
    verify_peer_certificate = false
  }
  # WebSocket を長く保つ（アプリは 25 秒ごとに ping を送る）
  connection_configuration {
    idle_timeout_in_seconds = 300
  }
}
