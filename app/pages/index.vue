<template>
  <Page>
    <ui-title-bar title="Tudoholic Size Charts" />

    <Card>
      <div class="stack">
        <Text
          as="h2"
          variant="headingMd"
        >
          Size charts, from the 1688 picture to the product page
        </Text>

        <Text
          v-if="loading"
          as="p"
          tone="subdued"
        >
          Connecting to your store…
        </Text>

        <Text
          v-else-if="shopName"
          as="p"
        >
          Connected to <strong>{{ shopName }}</strong>. The size chart tools arrive here next.
        </Text>

        <div
          v-else
          class="stack"
        >
          <Text
            as="p"
            tone="critical"
          >
            The app could not reach your store: {{ error }}
          </Text>
          <div>
            <Button @click="load">
              Try again
            </Button>
          </div>
        </div>
      </div>
    </Card>
  </Page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button, Card, Page, Text } from '@ownego/polaris-vue'

const loading = ref(true)
const shopName = ref<string | null>(null)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await $fetch<{ shop: string, name: string }>('/api/shop')
    shopName.value = response.name
  }
  catch (caught) {
    const failure = caught as { statusMessage?: string }
    error.value = failure.statusMessage || 'no answer from the server'
    shopName.value = null
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
