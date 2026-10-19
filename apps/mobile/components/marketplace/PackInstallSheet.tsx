// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The install wizard for an agent pack.
 *
 * A pack asks 2–4 questions before anything is created (what the team builds,
 * who signs off, how fast to respond) and answers land in its prompts and
 * workspace profile. Everything here is rendered from the pack's own
 * `setup.questions` — there is no per-pack UI — and the plan shown above the
 * button comes from the server's dry run of the same apply that the button
 * performs.
 */

import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { X } from 'lucide-react-native'

export interface PackQuestion {
  id: string
  header: string
  question: string
  type: 'text' | 'choice' | 'multi' | 'confirm'
  options?: string[]
  default?: string | string[] | boolean
  applies?: string
  required?: boolean
}

export interface PackPreviewResponse {
  questions: PackQuestion[]
  plan: string[]
  conflicts: string[]
}

export function PackInstallSheet({
  visible,
  packName,
  preview,
  loading,
  installing,
  error,
  onCancel,
  onInstall,
}: {
  visible: boolean
  packName: string
  preview: PackPreviewResponse | null
  loading?: boolean
  installing?: boolean
  error?: string | null
  onCancel: () => void
  onInstall: (answers: Record<string, unknown>) => void
}) {
  const questions = preview?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, unknown>>({})

  useEffect(() => {
    if (!visible) return
    const defaults: Record<string, unknown> = {}
    for (const q of questions) {
      if (q.default !== undefined) defaults[q.id] = q.default
      else if (q.type === 'multi') defaults[q.id] = []
    }
    setAnswers(defaults)
  }, [visible, questions.length])

  const missing = useMemo(
    () => questions.filter((q) => q.required !== false && q.type !== 'confirm' && isEmpty(answers[q.id])),
    [questions, answers],
  )

  const set = (id: string, value: unknown) => setAnswers((prev) => ({ ...prev, [id]: value }))

  const toggleMulti = (id: string, option: string) => {
    const current = Array.isArray(answers[id]) ? (answers[id] as string[]) : []
    const next = current.includes(option) ? current.filter((v) => v !== option) : [...current, option]
    set(id, next)
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/60">
        <View className="bg-background rounded-t-3xl max-h-[92%] border-t border-border">
          <View className="flex-row items-center justify-between px-5 pt-4 pb-2">
            <Text className="text-foreground text-lg font-semibold flex-1" numberOfLines={2}>
              Set up {packName}
            </Text>
            <Pressable onPress={onCancel} hitSlop={10} className="w-8 h-8 items-center justify-center">
              <X size={20} color="#8b8b8b" />
            </Pressable>
          </View>

          <ScrollView className="px-5" contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
            {loading && (
              <View className="py-8 items-center">
                <ActivityIndicator />
                <Text className="text-muted-foreground text-sm mt-2">Checking what this will create…</Text>
              </View>
            )}

            {!loading && questions.length === 0 && (
              <Text className="text-muted-foreground text-sm py-4">
                This listing asks nothing up front — installing adds its project as usual.
              </Text>
            )}

            {!loading &&
              questions.map((q) => (
                <View key={q.id} className="mb-5">
                  <Text className="text-foreground text-sm font-medium">{q.header}</Text>
                  <Text className="text-muted-foreground text-xs mt-1 mb-2">{q.question}</Text>

                  {(q.type === 'text' || !q.type) && (
                    <TextInput
                      value={typeof answers[q.id] === 'string' ? (answers[q.id] as string) : ''}
                      onChangeText={(v) => set(q.id, v)}
                      placeholder={typeof q.default === 'string' ? q.default : 'Type an answer'}
                      placeholderTextColor="#71717a"
                      className="bg-secondary text-foreground rounded-xl px-3 py-3 text-sm"
                    />
                  )}

                  {q.type === 'choice' && (
                    <View className="flex-row flex-wrap gap-2">
                      {(q.options ?? []).map((option) => {
                        const selected = answers[q.id] === option
                        return (
                          <Pressable
                            key={option}
                            onPress={() => set(q.id, option)}
                            className={`px-3 py-2 rounded-xl border ${selected ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                          >
                            <Text className={`text-xs ${selected ? 'text-primary' : 'text-foreground'}`}>{option}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}

                  {q.type === 'multi' && (
                    <View className="flex-row flex-wrap gap-2">
                      {(q.options ?? []).map((option) => {
                        const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : []
                        const selected = current.includes(option)
                        return (
                          <Pressable
                            key={option}
                            onPress={() => toggleMulti(q.id, option)}
                            className={`px-3 py-2 rounded-xl border ${selected ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                          >
                            <Text className={`text-xs ${selected ? 'text-primary' : 'text-foreground'}`}>{option}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}

                  {q.type === 'confirm' && (
                    <Pressable
                      onPress={() => set(q.id, answers[q.id] !== true)}
                      className={`self-start px-3 py-2 rounded-xl border ${answers[q.id] === true ? 'border-primary bg-primary/10' : 'border-border bg-secondary'}`}
                    >
                      <Text className={`text-xs ${answers[q.id] === true ? 'text-primary' : 'text-foreground'}`}>
                        {answers[q.id] === true ? 'Yes' : 'No'}
                      </Text>
                    </Pressable>
                  )}
                </View>
              ))}

            {!loading && (preview?.plan?.length ?? 0) > 0 && (
              <View className="bg-secondary rounded-2xl p-4 mb-3">
                <Text className="text-foreground text-sm font-medium mb-2">This will</Text>
                {preview!.plan.map((line) => (
                  <Text key={line} className="text-muted-foreground text-xs leading-5">
                    • {line}
                  </Text>
                ))}
              </View>
            )}

            {!loading &&
              (preview?.conflicts ?? []).map((line) => (
                <Text key={line} className="text-amber-500 text-xs mb-2">
                  {line}
                </Text>
              ))}

            {!!error && <Text className="text-red-500 text-xs mb-3">{error}</Text>}
          </ScrollView>

          <View className="px-5 pb-6 pt-2 border-t border-border">
            <Pressable
              disabled={loading || installing || missing.length > 0}
              onPress={() => onInstall(answers)}
              className={`rounded-xl py-3 items-center ${loading || installing || missing.length > 0 ? 'bg-primary/50' : 'bg-primary'}`}
            >
              {installing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="text-primary-foreground text-sm font-semibold">
                  {missing.length > 0 ? `Answer ${missing.length} more` : 'Install'}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}
