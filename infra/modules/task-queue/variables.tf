variable "name_prefix" {
  description = "Prefix for SQS queue names."
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "How long a task job is hidden while the scheduler processes it (must exceed worst-case task runtime)."
  type        = number
  default     = 7200
}

variable "max_receive_count" {
  description = "Receive attempts before a message moves to the DLQ."
  type        = number
  default     = 3
}

variable "tags" {
  description = "Tags applied to queue resources."
  type        = map(string)
  default     = {}
}
