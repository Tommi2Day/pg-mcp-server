{{/*
Expand the name of the chart.
*/}}
{{- define "pg-mcp-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "pg-mcp-server.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label.
*/}}
{{- define "pg-mcp-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "pg-mcp-server.labels" -}}
helm.sh/chart: {{ include "pg-mcp-server.chart" . }}
{{ include "pg-mcp-server.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "pg-mcp-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pg-mcp-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
SANs for the auto-generated self-signed cert: the Service DNS names (short, namespaced,
.svc and FQDN) so in-cluster clients can verify it, plus the user-supplied tls.san.
*/}}
{{- define "pg-mcp-server.tlsSan" -}}
{{- $svc := include "pg-mcp-server.fullname" . }}
{{- $ns := .Release.Namespace }}
{{- $san := list (printf "DNS:%s" $svc) (printf "DNS:%s.%s" $svc $ns) (printf "DNS:%s.%s.svc" $svc $ns) (printf "DNS:%s.%s.svc.%s" $svc $ns .Values.tls.clusterDomain) }}
{{- with .Values.tls.san }}
{{- $san = append $san . }}
{{- end }}
{{- join "," $san }}
{{- end }}
