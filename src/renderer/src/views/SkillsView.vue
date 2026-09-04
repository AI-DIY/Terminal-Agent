<script setup lang="ts">
import { ArrowLeft, Bot, Braces, Check, ShieldCheck, Sparkles, Terminal } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch, type Component } from 'vue'
import { BUILT_IN_SKILLS, type BuiltInSkillId } from '../../../shared/built-in-skills'
import { DISPLAY_NAME_MAX_LENGTH, getUserPreferencesStore } from '../stores/user-preferences'
import { getSsoStore } from '../stores/sso'

const emit = defineEmits<{ close: [] }>()
const preferences = getUserPreferencesStore()
const sso = getSsoStore()

type SkillDefinition = (typeof BUILT_IN_SKILLS)[number] & { icon: Component }

const SKILL_ICONS: Record<BuiltInSkillId, Component> = {
  'teleagent-operations': Bot,
  'codex-development': Braces,
  'ssh-troubleshooting': Terminal,
  'security-review': ShieldCheck,
}

const SKILLS: readonly SkillDefinition[] = BUILT_IN_SKILLS.map(skill => ({ ...skill, icon: SKILL_ICONS[skill.id] }))

const draftDisplayName = ref(preferences.state.displayName)
const savedNotice = ref('')
let savedNoticeTimer: ReturnType<typeof setTimeout> | undefined

watch(() => preferences.state.displayName, value => {
  if (value !== draftDisplayName.value) draftDisplayName.value = value
})

const enabledCount = computed(() => sso.skillsAvailable.value ? SKILLS.filter(skill => preferences.state.skills[skill.id]).length : 0)

function saveDisplayName(): void {
  preferences.setDisplayName(draftDisplayName.value)
  draftDisplayName.value = preferences.state.displayName
  savedNotice.value = preferences.state.displayName ? '欢迎语已保存' : '已恢复默认称呼'
  if (savedNoticeTimer) clearTimeout(savedNoticeTimer)
  savedNoticeTimer = setTimeout(() => { savedNotice.value = '' }, 2200)
}

function toggleSkill(skill: SkillDefinition): void {
  if (!sso.skillsAvailable.value) return
  preferences.setSkillEnabled(skill.id, !preferences.state.skills[skill.id])
}

function closeSkills(): void {
  // Persist an edit even when the user clicks Back before the input's blur
  // event has fired (for example with a touchpad or keyboard shortcut).
  if (draftDisplayName.value !== preferences.state.displayName) saveDisplayName()
  if (savedNoticeTimer) clearTimeout(savedNoticeTimer)
  emit('close')
}

onBeforeUnmount(() => {
  if (savedNoticeTimer) clearTimeout(savedNoticeTimer)
})
</script>

<template>
  <main class="skills">
    <header class="skills-top">
      <button type="button" class="back-button" @click="closeSkills"><ArrowLeft :size="15" aria-hidden="true" /><span>返回工作台</span></button>
      <h1><Sparkles :size="18" aria-hidden="true" />技能</h1>
      <span class="skills-summary">已启用 {{ enabledCount }} / {{ SKILLS.length }}</span>
    </header>

    <section class="skills-content" aria-label="技能设置">
      <section class="welcome-panel" aria-labelledby="welcome-title">
        <div class="section-heading">
          <div>
            <h2 id="welcome-title">欢迎语</h2>
            <p>设置工作台顶部显示的姓名，内容仅保存在本机。</p>
          </div>
          <span class="local-badge">本地保存</span>
        </div>
        <label class="display-name-field">
          <span>显示姓名</span>
          <input v-model="draftDisplayName" type="text" :maxlength="DISPLAY_NAME_MAX_LENGTH" autocomplete="nickname" placeholder="例如：小明" aria-label="工作台显示姓名" @blur="saveDisplayName" @keydown.enter.prevent="saveDisplayName">
        </label>
        <div class="welcome-preview" aria-live="polite">
          <span>预览</span><strong>欢迎回来，{{ preferences.state.displayName || '朋友' }}</strong><em v-if="savedNotice">{{ savedNotice }}</em>
        </div>
      </section>

      <section class="catalog-panel" aria-labelledby="catalog-title">
        <p v-if="!sso.skillsAvailable" class="skills-restriction" role="alert">未登录状态不能使用技能</p>
        <div class="section-heading">
          <div>
            <h2 id="catalog-title">内置技能</h2>
            <p>技能会为 AI 工作区提供对应的工作方法和提示，可随时启用或停用。</p>
          </div>
          <span class="catalog-badge">无需联网</span>
        </div>
        <div class="skill-grid">
          <article v-for="skill in SKILLS" :key="skill.id" class="skill-card" :class="{ enabled: sso.skillsAvailable && preferences.state.skills[skill.id] }">
            <div class="skill-card-head">
              <span class="skill-icon"><component :is="skill.icon" :size="17" aria-hidden="true" /></span>
              <div class="skill-card-title"><h3>{{ skill.name }}</h3><span>{{ skill.source }}</span></div>
              <label class="skill-toggle">
                <input type="checkbox" :checked="preferences.state.skills[skill.id]" :disabled="!sso.skillsAvailable" :aria-label="`${preferences.state.skills[skill.id] ? '停用' : '启用'} ${skill.name}`" @change="toggleSkill(skill)">
                <span aria-hidden="true" class="toggle-track"><span class="toggle-thumb" /></span>
              </label>
            </div>
            <p>{{ skill.description }}</p>
            <small><Check :size="12" aria-hidden="true" />{{ skill.detail }}</small>
            <span class="skill-status">{{ sso.skillsAvailable && preferences.state.skills[skill.id] ? '已启用' : '已停用' }}</span>
          </article>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.skills { display: grid; grid-template-rows: 56px minmax(0, 1fr); --window-controls-inset: max(138px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))); width: 100vw; min-width: 0; height: 100vh; min-height: 0; margin: 0; overflow: hidden; border: 0; border-radius: 0; background: var(--surface); color: var(--text); box-shadow: none; }
.skills-top { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 0 calc(16px + var(--window-controls-inset)) 0 16px; border-bottom: 1px solid var(--line); background: var(--chrome); -webkit-app-region: drag; }
.skills-top h1 { display: inline-flex; align-items: center; gap: 7px; margin: 0; color: var(--text-strong); font-size: 17px; font-weight: 700; }
.back-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 600; -webkit-app-region: no-drag; }
.back-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.skills-summary { margin-left: auto; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.skills-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 28px 34px 38px; background: var(--surface); }
.welcome-panel,.catalog-panel { display: grid; gap: 14px; width: 100%; max-width: 1120px; margin: 0 auto 26px; }
.catalog-panel { margin-bottom: 0; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; min-width: 0; }
.section-heading h2 { margin: 0; color: var(--text-strong); font-size: 19px; font-weight: 700; }
.section-heading p { max-width: 720px; margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.local-badge,.catalog-badge { flex: 0 0 auto; padding: 4px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 9px; font-weight: 650; }
.display-name-field { display: grid; grid-template-columns: 92px minmax(180px, 420px); align-items: center; gap: 10px; color: var(--text); font-size: 11px; }
.display-name-field input { width: 100%; height: 32px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text-strong); font-size: 11px; }
.display-name-field input:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.welcome-preview { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 7px 10px; border: 1px solid var(--line-soft); border-radius: 5px; background: var(--surface-soft); color: var(--muted); font-size: 10px; }
.welcome-preview strong { color: var(--text-strong); font-size: 11px; font-weight: 680; }
.welcome-preview em { margin-left: auto; color: var(--green); font-size: 10px; font-style: normal; }
.skill-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; min-width: 0; }
.skill-card { position: relative; display: grid; gap: 9px; min-width: 0; min-height: 164px; padding: 14px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft); transition: border-color .15s ease, background .15s ease; }
.skill-card.enabled { border-color: color-mix(in srgb, var(--accent) 52%, var(--line)); background: color-mix(in srgb, var(--accent-soft) 28%, var(--surface-soft)); }
.skill-card-head { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.skill-icon { display: grid; flex: 0 0 auto; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--accent); }
.skill-card-title { min-width: 0; flex: 1; }
.skill-card-title h3 { margin: 0; overflow: hidden; color: var(--text-strong); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.skill-card-title span { display: block; margin-top: 3px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.skill-card p { min-height: 34px; margin: 0; color: var(--text); font-size: 10px; line-height: 1.55; }
.skill-card small { display: flex; align-items: flex-start; gap: 5px; min-width: 0; color: var(--muted); font-size: 9px; line-height: 1.45; }
.skill-card small svg { flex: 0 0 auto; margin-top: 1px; color: var(--green); }
.skill-status { justify-self: start; padding: 3px 6px; border-radius: 4px; background: var(--line-soft); color: var(--muted); font-size: 9px; font-weight: 650; }
.skill-card.enabled .skill-status { background: var(--green-soft); color: var(--green); }
.skill-toggle { display: inline-flex; flex: 0 0 auto; align-items: center; cursor: pointer; }
.skill-toggle input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.skill-toggle input:focus-visible + .toggle-track { outline: 2px solid var(--focus); outline-offset: 2px; }
.toggle-track { display: inline-flex; align-items: center; width: 32px; height: 18px; padding: 2px; border-radius: 999px; background: var(--line); transition: background .15s ease; }
.toggle-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 20%); transition: transform .15s ease; }
.skill-toggle input:checked + .toggle-track { background: var(--accent); }
.skill-toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(14px); }
@media (max-width: 760px) { .skills-content { padding: 22px 18px 30px; }.display-name-field { grid-template-columns: 1fr; gap: 5px; }.section-heading { display: grid; gap: 8px; }.skills-summary { margin-left: 0; } }
</style>
