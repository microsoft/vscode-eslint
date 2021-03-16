<template lang="pug">
  #app
    component(:is="component")
      slot
</template>

<script>
import PublicLayout from '@/layouts/public/main.vue';
import DefaultLayout from '@/layouts/default/main.vue';
export default {
	name: 'App',
	components: {
		PublicLayout,
		DefaultLayout
	},
	computed: {
		component () {
			return this.$store.state.common.layout;
		}
	},
	mounted () {
		// Update page title.
		this.$store.watch((state) => {
			return state.common.title;
		}, (title) => {
			document.title = title;
			console.log('title updated');
		}, {
			deep: true
		});
	}
};
</script>