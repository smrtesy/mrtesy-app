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
      projects: {
        Row: {
          color: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          name_he: string | null
          organization_id: string | null
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
          remind_at: string
          recurrence_rule: string | null
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
          attachments_info: string | null
          body_text: string | null
          created_at: string | null
          dead_letter: boolean | null
          id: string
          metadata: Json | null
          processing_status: string | null
          raw_content: string | null
          received_at: string | null
          reply_to_context: string | null
          sender: string | null
          sender_email: string | null
          source_id: string
          source_type: string
          subject: string | null
          updated_at: string | null
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
          // Core fields
          id: string
          user_id: string | null
          title: string
          title_he: string | null
          description: string | null
          priority: string | null
          status: string | null
          task_type: string | null

          // Timing
          due_date: string | null
          due_time: string | null
          reminder_at: string | null
          recurrence_rule: string | null
          snoozed_until: string | null
          snooze_count: number | null
          completed_at: string | null
          seen_at: string | null
          last_interaction_at: string | null
          created_at: string | null
          updated_at: string | null

          // Relationships
          project_id: string | null
          source_message_id: string | null
          source_link: string | null
          related_contact: string | null
          related_contact_email: string | null
          related_contact_phone: string | null

          // AI fields
          ai_actions: Json | null
          ai_generated_content: Json | null
          ai_confidence: number | null
          ai_model_used: string | null
          manually_verified: boolean | null

          // Rich content
          tags: string[] | null
          updates: Json | null
          linked_drive_docs: Json | null

          // Action tracking
          requested_action: string | null
          custom_action: string | null
          action_status: string | null
          action_result: string | null
          action_error: string | null
          action_retry_count: number | null
          action_completed_at: string | null
          draft_link: string | null
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
          calendar_connected: boolean | null
          classification_model: string | null
          created_at: string | null
          daily_ai_budget_usd: number | null
          display_name: string | null
          drive_connected: boolean | null
          gmail_connected: boolean | null
          id: string
          my_emails: string[] | null
          office_addresses: string[] | null
          onboarding_completed: boolean | null
          plan: string | null
          preferred_language: string | null
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

      // ── New tables added in migration 20260424000001 ──────────────────

      rules_memory: {
        Row: {
          id: string
          user_id: string
          trigger: string
          rule_type: string
          category: string | null
          action: string | null
          reason: string | null
          is_active: boolean
          created_by: string
          suggested_by_run_id: string | null
          suggestion_confidence: number | null
          suggestion_status: string | null
          user_feedback: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }

      run_sessions: {
        Row: {
          id: string
          user_id: string
          run_title: string
          run_type: string
          part: string
          status: string
          started_at: string
          ended_at: string | null
          duration_seconds: number | null
          model_used: string | null
          items_processed: number | null
          items_skipped: number | null
          tasks_created: number | null
          tasks_updated: number | null
          actionable_count: number | null
          informational_count: number | null
          rules_added: number | null
          errors_count: number | null
          summary: string | null
          errors_log: Json | null
          metadata: Json | null
          created_at: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }

      action_history: {
        Row: {
          id: string
          user_id: string
          task_id: string | null
          action_type: string
          status: string
          requested_at: string
          completed_at: string | null
          summary: string | null
          result: string | null
          error: string | null
          model_used: string | null
          cost_usd: number | null
          created_at: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }

      sync_schedules: {
        Row: {
          id: string
          user_id: string
          part: string
          is_auto: boolean
          cron_expr: string
          last_run_at: string | null
          next_run_at: string | null
          is_enabled: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          [key: string]: unknown
        }
        Update: {
          [key: string]: unknown
        }
      }

      ai_prompts: {
        Row: {
          id: string
          user_id: string
          prompt_key: string
          version: number
          is_active: boolean
          content: string
          notes: string | null
          created_at: string
          updated_at: string
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
