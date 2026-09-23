import PolarisVue from '@ownego/polaris-vue'
import '@ownego/polaris-vue/dist/style.css'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(PolarisVue)
})
