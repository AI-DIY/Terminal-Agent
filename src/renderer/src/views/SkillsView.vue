<script setup lang="ts">
import { ArrowLeft, Bot, Check, CircleAlert, CircleHelp, RefreshCw, Sparkles } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { SkillSummary } from '../../../shared/skill-contracts'
import { getSsoStore } from '../stores/sso'
import { getSkillsStore } from '../stores/skills'

const emit = defineEmits<{ close: [] }>()
const sso = getSsoStore()
const skills = getSkillsStore()
const catalog = computed(() => skills.state.catalog)
const skillList = computed(() => catalog.value.skills)
const enabledCount = computed(() => skillList.value.filter(skill => skill.enabled).length)

function skillControl(id: string): SkillSummary {
  return skillList.value.find(skill => skill.id === id) ?? { id: id as SkillSummary['id'], name: id as SkillSummary['name'], description: '', enabled: false }
}

function iconFor(_skill: SkillSummary): typeof Bot {
  // Keep a stable, neutral icon while allowing arbitrary user-provided IDs.
  return Bot
}

async function refreshSkills(): Promise<void> {
  await skills.refresh().catch(() => undefined)
}

async function toggleSkill(skill: SkillSummary): Promise<void> {
  if (!sso.skillsAvailable.value) return
  await skills.setEnabled({ id: skill.id, enabled: !skill.enabled }).catch(() => undefined)
}

function closeSkills(): void {
  emit('close')
}

onMounted(() => { void skills.hydrate() })
onBeforeUnmount(() => skills.dispose())
</script>

<template>
  <main class="skills">
    <header class="skills-top">
      <button type="button" class="back-button" @click="closeSkills"><ArrowLeft :size="15" aria-hidden="true" /><span>返回工作台</span></button>
      <h1><Sparkles :size="18" aria-hidden="true" />技能</h1>
      <button type="button" class="refresh-button" :disabled="skills.state.loading" @click="refreshSkills"><RefreshCw :size="13" :class="{ spinning: skills.state.loading }" aria-hidden="true" /><span>刷新</span></button>
      <span class="skills-summary">已启用 {{ enabledCount }} / {{ skillList.length }}</span>
    </header>

    <section class="skills-content" aria-label="技能设置">
      <section class="catalog-panel" aria-labelledby="catalog-title">
        <p v-if="!sso.skillsAvailable" class="skills-restriction" role="alert">未登录状态不能使用技能</p>
        <div class="section-heading">
          <div>
            <h2 id="catalog-title">可用技能</h2>
            <p>选择需要在 AI 工作区中使用的标准 Skill。将标准 Skill 放入 .skills 目录后可刷新发现。</p>
          </div>
        </div>
        <p v-if="skills.state.error" class="skills-error" role="alert"><CircleAlert :size="14" aria-hidden="true" />{{ skills.state.error }}</p>
        <div v-if="!skills.state.loading && skillList.length === 0" class="skills-empty" role="status"><CircleHelp :size="20" aria-hidden="true" /><strong>暂无可用技能</strong><span>请将包含 YAML 头部和正文的 SKILL.md 放入项目根目录 .skills/&lt;skill-name&gt;。</span></div>
        <div v-else class="skill-grid">
          <article v-for="skill in skillList" :key="skill.id" class="skill-card" :class="{ enabled: skill.enabled }">
            <div class="skill-card-head">
              <span class="skill-icon"><component :is="iconFor(skill)" :size="17" aria-hidden="true" /></span>
              <div class="skill-card-title"><h3>{{ skill.name }}</h3><span>{{ skill.id }}</span></div>
              <label class="skill-toggle">
                <input type="checkbox" :checked="skillControl(skill.id).enabled" :disabled="!sso.skillsAvailable || skills.state.loading" :aria-label="`${skillControl(skill.id).enabled ? '停用' : '启用'} ${skill.name}`" @change="toggleSkill(skill)">
                <span aria-hidden="true" class="toggle-track"><span class="toggle-thumb" /></span>
              </label>
            </div>
            <p>{{ skill.description }}</p>
            <small><Check :size="12" aria-hidden="true" />标准 SKILL.md</small>
            <span class="skill-status">{{ skillControl(skill.id).enabled ? '已启用' : '未启用' }}</span>
          </article>
        </div>
        <div v-if="catalog.diagnostics.length" class="skills-diagnostics" role="status">
          <strong><CircleAlert :size="13" aria-hidden="true" />发现 {{ catalog.diagnostics.length }} 个目录问题</strong>
          <p v-for="item in catalog.diagnostics" :key="`${item.directory}:${item.code}`">{{ item.directory }}：{{ item.message }}</p>
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
.refresh-button { display: inline-flex; align-items: center; gap: 5px; height: 27px; padding: 0 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; -webkit-app-region: no-drag; }
.refresh-button:hover:not(:disabled) { border-color: var(--focus); color: var(--text-strong); }
.refresh-button:disabled { cursor: wait; opacity: .6; }
.refresh-button .spinning { animation: skills-spin .8s linear infinite; }
.skills-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 28px 34px 38px; background: var(--surface); }
.catalog-panel { display: grid; gap: 14px; width: 100%; max-width: 1120px; margin: 0 auto; }
.catalog-panel { margin-bottom: 0; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; min-width: 0; }
.section-heading h2 { margin: 0; color: var(--text-strong); font-size: 19px; font-weight: 700; }
.section-heading p { max-width: 720px; margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
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
.skills-error { display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--red) 40%, var(--line)); border-radius: 5px; background: color-mix(in srgb, var(--red) 8%, var(--surface)); color: var(--red); font-size: 10px; }
.skills-empty { display: grid; justify-items: center; gap: 7px; padding: 38px 18px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); text-align: center; }
.skills-empty svg { color: var(--accent); }.skills-empty strong { color: var(--text-strong); font-size: 12px; }.skills-empty span { max-width: 360px; font-size: 10px; line-height: 1.55; }
.skills-diagnostics { display: grid; gap: 4px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); color: var(--muted); font-size: 9px; line-height: 1.45; }
.skills-diagnostics strong { display: inline-flex; align-items: center; gap: 5px; color: var(--amber); font-size: 10px; }.skills-diagnostics p { margin: 0; overflow-wrap: anywhere; }
@keyframes skills-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .skills-content { padding: 22px 18px 30px; }.section-heading { display: grid; gap: 8px; }.skills-summary { margin-left: 0; } }
</style>
