export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      contacts: {
        Row: {
          ai_notes: string | null
          communication_style: string | null
          contact_type: string | null
          created_at: string | null
          email: string | null
          id: string
          last_interaction_at: string | null
          name: string
          name_he: string | null
          notes: string | null
          organization: string | null
          phone: string | null
          preferred_channel: string | null
          preferred_language: string | null
          tags: string[] | null
          total_interactions: number | null
          user_id: string | null
          whatsapp_phone: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      log_entries: {
        Row: {
          ai_classification: string | null
          ai_cost_usd: number | null
          ai_input_tokens: number | null
          ai_model_used: string | null
          ai_output_tokens: number | null
          category: string
          classification_reason: string | null
          created_at: string | null
          details: Json | null
          error_message: string | null
          id: string
          level: string | null
          message_received_at: string | null
          pre_classification: string | null
          processing_duration_ms: number | null
          retry_count: number | null
          sender: string | null
          sender_email: string | null
          source_id: string | null
          source_message_id: string | null
          source_type: string | null
          source_url: string | null
          status: string | null
          subject: string | null
          task_action: string | null
          task_id: string | null
          task_title: string | null
          user_id: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      project_briefs: {
        Row: {
          ai_context: string | null
          ai_updated_at: string | null
          created_at: string | null
          current_status: string | null
          drive_folder_id: string | null
          id: string
          important_links: Json | null
          kpis: string | null
          project_id: string | null
          purpose: string | null
          sub_projects: Json | null
          systems: Json | null
          target_audience: string | null
          updated_at: string | null
          user_id: string | null
          weekly_workflow: Json | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      project_credentials: {
        Row: {
          api_key_encrypted: string | null
          created_at: string | null
          id: string
          notes: string | null
          password_encrypted: string | null
          project_id: string | null
          system_name: string
          url: string | null
          user_id: string | null
          username: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      projects: {
        Row: {
          color: string | null
          created_at: string | null
          gcal_calendar_id: string | null
          gmail_label_id: string | null
          id: string
          is_active: boolean | null
          name: string
          name_he: string | null
          organization_id: string | null
          parent_id: string | null
          template_type: string | null
          user_id: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      reminders: {
        Row: {
          channel: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          is_sent: boolean | null
          message: string | null
          message_he: string | null
          next_occurrence: string | null
          paused_until: string | null
          remind_at: string
          recurrence_rule: string | null
          sent_at: string | null
          source: string | null
          task_id: string | null
          title_he: string | null
          user_id: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      source_messages: {
        Row: {
          ai_classification: string | null
          ai_extraction: Json | null
          body_text: string | null
          created_at: string | null
          dead_letter: boolean | null
          detailed_summary: string | null
          has_attachments: boolean | null
          id: string
          is_customer_inquiry: boolean | null
          language: string | null
          needs_project_check: boolean | null
          processed_at: string | null
          processing_lock_at: string | null
          processing_status: string | null
          received_at: string | null
          recipient: string | null
          retry_count: number | null
          scan_run_id: string | null
          sender: string | null
          sender_email: string | null
          sender_phone: string | null
          skip_reason: string | null
          source_account: string | null
          source_id: string
          source_type: string
          source_url: string | null
          subject: string | null
          user_id: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      sync_state: {
        Row: {
          checkpoint: string | null
          consecutive_failures: number | null
          id: string
          last_error: string | null
          last_synced_at: string | null
          messages_synced_total: number | null
          retry_count: number | null
          source: string
          user_id: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      task_activities: {
        Row: {
          id: string
          task_id: string
          user_id: string
          activity_type: string
          old_value: string | null
          new_value: string | null
          note: string | null
          actor: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          task_id: string
          user_id: string
          activity_type: string
          old_value?: string | null
          new_value?: string | null
          note?: string | null
          actor?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          task_id?: string
          user_id?: string
          activity_type?: string
          old_value?: string | null
          new_value?: string | null
          note?: string | null
          actor?: string | null
          created_at?: string | null
        }
      }
      tasks: {
        Row: {
          ai_actions: Json | null
          ai_confidence: number | null
          ai_generated_content: Json | null
          ai_model_used: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          description: string | null
          due_date: string | null
          due_time: string | null
          id: string
          last_interaction_at: string | null
          last_updated_reason: string | null
          linked_drive_docs: Json | null
          manually_verified: boolean | null
          organization_id: string | null
          priority: string | null
          project_id: string | null
          recurrence_rule: string | null
          related_contact: string | null
          related_contact_email: string | null
          related_contact_phone: string | null
          reminder_at: string | null
          seen_at: string | null
          snooze_count: number | null
          snoozed_until: string | null
          source_message_id: string | null
          status: string | null
          status_changed_at: string | null
          tags: string[] | null
          task_type: string | null
          title: string
          title_he: string | null
          updated_at: string | null
          updates: Json | null
          user_id: string | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      user_credentials: {
        Row: {
          access_token: string
          email: string | null
          expires_at: string | null
          id: string
          refresh_token: string | null
          scopes: string[] | null
          service: string
          user_id: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
      user_settings: {
        Row: {
          ai_clarification_prefs: Json | null
          calendar_allday_tasks: boolean | null
          calendar_connected: boolean | null
          calendar_event_filter: string | null
          calendar_holidays_tasks: boolean | null
          calendar_initial_scan_months: number | null
          classification_model: string | null
          created_at: string | null
          daily_ai_budget_usd: number | null
          default_reminder_timing: string | null
          display_name: string | null
          drive_connected: boolean | null
          drive_folder_id: string | null
          gmail_connected: boolean | null
          id: string
          initial_scan_completed_at: string | null
          initial_scan_days_back: number | null
          initial_scan_started_at: string | null
          initial_setup_completed: boolean | null
          my_emails: string[] | null
          office_addresses: string[] | null
          onboarding_completed: boolean | null
          plan: string | null
          preferred_language: string | null
          reminder_channels: string[] | null
          show_ai_costs: boolean | null
          skip_recipients: string[] | null
          skip_senders: string[] | null
          summary_model: string | null
          timezone: string | null
          user_id: string
          whatsapp_connected: boolean | null
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}
