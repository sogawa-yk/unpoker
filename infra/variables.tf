variable "oci_profile" {
  description = "~/.oci/config のプロファイル名（terraform.tfvars に書く）"
  type        = string
  default     = "DEFAULT"
}

variable "region" {
  type    = string
  default = "ap-osaka-1"
}

variable "compartment_ocid" {
  description = "デプロイ先コンパートメントの OCID（terraform.tfvars に書く。git 管理外）"
  type        = string
}

variable "name" {
  type    = string
  default = "unpoker"
}

variable "image_tag" {
  description = "OCIR に push したイメージのタグ。変えると Container Instance を作り直す"
  type        = string
  default     = "latest"
}

variable "origin_cert_path" {
  description = "Cloudflare Origin CA 証明書（PEM）のパス"
  type        = string
}

variable "origin_key_path" {
  description = "Cloudflare Origin CA 証明書の秘密鍵（PEM）のパス。tfstate に入るので、state は手元だけに置く"
  type        = string
}

variable "cloudflare_ipv4" {
  description = "LB の 443 番に接続を許す Cloudflare の IP 範囲。最新は https://www.cloudflare.com/ips-v4 で確認する"
  type        = list(string)
  default = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}

variable "app_private_ip" {
  description = "Container Instance に固定で割り当てる private IP（LB のバックエンドに使う）"
  type        = string
  default     = "10.20.1.10"
}
