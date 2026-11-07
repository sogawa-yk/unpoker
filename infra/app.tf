data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.compartment_ocid
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

locals {
  # 大阪のリージョンキーは kix
  image_url = "kix.ocir.io/${data.oci_objectstorage_namespace.ns.namespace}/${var.name}/server:${var.image_tag}"
}

resource "oci_artifacts_container_repository" "server" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name}/server"
  is_public      = false
}

# ルームの状態のスナップショット（再起動時の復旧用）。24 時間で自動的に消える
resource "oci_nosql_table" "rooms" {
  compartment_id = var.compartment_ocid
  name           = "${var.name}_rooms"
  ddl_statement  = "CREATE TABLE ${var.name}_rooms (id STRING, updatedAt LONG, data STRING, PRIMARY KEY(id)) USING TTL 1 DAYS"
  table_limits {
    capacity_mode      = "ON_DEMAND"
    max_storage_in_gbs = 1
    max_read_units     = 0
    max_write_units    = 0
  }
}

# アプリ本体。OCIR からの pull と NoSQL への読み書きは、リソース・プリンシパル（既存の動的グループ）で行う
resource "oci_container_instances_container_instance" "app" {
  compartment_id           = var.compartment_ocid
  availability_domain      = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name             = "${var.name}-app"
  shape                    = "CI.Standard.A1.Flex"
  container_restart_policy = "ALWAYS"
  shape_config {
    ocpus         = 1
    memory_in_gbs = 2
  }
  containers {
    display_name = "${var.name}-server"
    image_url    = local.image_url
    environment_variables = {
      PORT              = "8080"
      STORE             = "nosql"
      NOSQL_TABLE       = oci_nosql_table.rooms.name
      NOSQL_REGION      = var.region
      NOSQL_COMPARTMENT = var.compartment_ocid
      NOSQL_AUTH        = "resource_principal"
    }
  }
  vnics {
    subnet_id             = oci_core_subnet.private.id
    nsg_ids               = [oci_core_network_security_group.app.id]
    private_ip            = var.app_private_ip
    is_public_ip_assigned = false
  }
  depends_on = [oci_artifacts_container_repository.server]
}
